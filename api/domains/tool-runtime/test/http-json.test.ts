import { afterAll, beforeAll, expect, test } from "bun:test";
import { z } from "zod";
import type { HttpJsonBindingV1 } from "../../capabilities";
import { createHttpJsonExecutor, type HttpJsonConnection } from "..";

const seen: Array<{
	method: string;
	path: string;
	headers: Headers;
	body: string;
}> = [];
let flaky = 0;
let server: ReturnType<typeof Bun.serve>;
let base = "";

beforeAll(() => {
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			seen.push({
				method: request.method,
				path: url.pathname + url.search,
				headers: request.headers,
				body: await request.text(),
			});
			if (url.pathname === "/items/redirect")
				return new Response(null, {
					status: 302,
					headers: { location: "http://127.0.0.1:1/x" },
				});
			if (url.pathname === "/items/big")
				return Response.json({ id: "big", pad: "x".repeat(5000) });
			if (url.pathname === "/items/slow") {
				await Bun.sleep(1000);
				return Response.json({ id: "slow" });
			}
			if (url.pathname === "/items/wrong") return Response.json({ nope: true });
			if (url.pathname === "/items/text")
				return new Response("hello", {
					headers: { "content-type": "text/plain" },
				});
			if (url.pathname === "/items/missing")
				return new Response("{}", {
					status: 404,
					headers: { "content-type": "application/json" },
				});
			if (url.pathname === "/orders" && request.method === "POST") {
				flaky++;
				if (flaky === 1)
					return new Response("{}", {
						status: 503,
						headers: { "content-type": "application/json" },
					});
				return Response.json({ orderId: "o-1" }, { status: 201 });
			}
			if (url.pathname.startsWith("/prefix/items/"))
				return Response.json({ id: url.pathname.split("/").pop() });
			return Response.json({ id: url.pathname.split("/").pop() });
		},
	});
	base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

const item = z.strictObject({ id: z.string() });
const itemInput = z.strictObject({ itemId: z.string() });
const getBinding = (
	patch: Partial<HttpJsonBindingV1> = {},
): HttpJsonBindingV1 => ({
	kind: "http-binding",
	id: "fixture-item.read",
	revision: 1,
	transport: "http-json",
	connectionRef: "connection:fixture",
	method: "GET",
	pathTemplate: "/items/{itemId}",
	pathFields: { itemId: { inputField: "itemId" } },
	queryFields: {},
	bodyFields: {},
	inputSchemaRef: "schema:fixture-item-id@1",
	outputSchemaRef: "schema:fixture-item@1",
	permission: "read",
	timeoutMs: 300,
	maxResponseBytes: 1024,
	retry: { mode: "none" },
	...patch,
});
const connection = (
	patch: Partial<HttpJsonConnection> = {},
): HttpJsonConnection => ({
	baseUrl: base,
	headers: () => ({ authorization: "Bearer SECRET-TOKEN" }),
	allowHosts: ["127.0.0.1"],
	...patch,
});
const executor = (conn = connection(), allowLoopbackHttp = true) =>
	createHttpJsonExecutor({
		connections: new Map([["connection:fixture", conn]]),
		allowLoopbackHttp,
	});
const run = (
	exec: ReturnType<typeof executor>,
	binding: HttpJsonBindingV1,
	input: unknown,
	extra: {
		idempotencyKey?: string;
		inputSchema?: z.ZodType;
		outputSchema?: z.ZodType;
	} = {},
) =>
	exec.execute({
		binding,
		input,
		inputSchema: extra.inputSchema ?? itemInput,
		outputSchema: extra.outputSchema ?? item,
		idempotencyKey: extra.idempotencyKey,
	});

test("GET success injects backend credentials and validates the output", async () => {
	seen.length = 0;
	const result = await run(executor(), getBinding(), { itemId: "abc" });
	expect(result).toEqual({ ok: true, value: { id: "abc" }, attempts: 1 });
	expect(seen[0]!.method).toBe("GET");
	expect(seen[0]!.headers.get("authorization")).toBe("Bearer SECRET-TOKEN");
	expect(JSON.stringify(result)).not.toContain("SECRET-TOKEN");
});

test("query fields, literals and a base path prefix are mapped without expressions", async () => {
	seen.length = 0;
	const result = await run(
		executor(connection({ baseUrl: `${base}/prefix` })),
		getBinding({
			queryFields: { q: { literal: "a b" }, id: { inputField: "itemId" } },
		}),
		{ itemId: "x y" },
	);
	expect(result.ok).toBe(true);
	expect(seen[0]!.path).toBe("/prefix/items/x%20y?q=a+b&id=x+y");
});

test("path values cannot escape the template", async () => {
	for (const itemId of ["..", ".", "../admin", ""]) {
		const result = await run(executor(), getBinding(), { itemId });
		expect(result).toMatchObject({ ok: false, code: "invalid_input" });
	}
	seen.length = 0;
	await run(executor(), getBinding(), { itemId: "a/b?c#d" });
	expect(seen[0]!.path).toBe("/items/a%2Fb%3Fc%23d");
});

test("redirects are refused and not followed", async () => {
	seen.length = 0;
	const result = await run(executor(), getBinding(), { itemId: "redirect" });
	expect(result).toMatchObject({
		ok: false,
		code: "redirect_rejected",
		attempts: 1,
	});
	expect(seen).toHaveLength(1);
});

test("response size is limited while streaming", async () => {
	const result = await run(executor(), getBinding({ maxResponseBytes: 256 }), {
		itemId: "big",
	});
	expect(result).toMatchObject({ ok: false, code: "response_too_large" });
});

test("timeout, schema mismatch, status and content-type failures use fixed codes", async () => {
	expect(
		await run(executor(), getBinding({ timeoutMs: 100 }), { itemId: "slow" }),
	).toMatchObject({ ok: false, code: "timeout", attempts: 1 });
	expect(
		await run(executor(), getBinding(), { itemId: "wrong" }),
	).toMatchObject({ ok: false, code: "schema_mismatch" });
	expect(
		await run(executor(), getBinding(), { itemId: "missing" }),
	).toMatchObject({ ok: false, code: "upstream_client_error" });
	expect(await run(executor(), getBinding(), { itemId: "text" })).toMatchObject(
		{ ok: false, code: "invalid_response" },
	);
	expect(await run(executor(), getBinding(), { other: 1 })).toMatchObject({
		ok: false,
		code: "invalid_input",
	});
});

test("hosts outside the allowlist, plain http, private addresses and unknown connections are refused", async () => {
	seen.length = 0;
	expect(
		await run(
			executor(connection({ allowHosts: ["example.com"] })),
			getBinding(),
			{ itemId: "a" },
		),
	).toMatchObject({ ok: false, code: "host_not_allowed" });
	expect(
		await run(executor(connection(), false), getBinding(), { itemId: "a" }),
	).toMatchObject({ ok: false, code: "insecure_transport" });
	for (const baseUrl of [
		"https://169.254.169.254",
		"https://10.0.0.5",
		"https://192.168.1.1",
		"https://localhost",
		"https://[::1]",
	]) {
		const host = new URL(baseUrl).hostname;
		expect(
			await run(
				executor(connection({ baseUrl, allowHosts: [host] })),
				getBinding(),
				{ itemId: "a" },
			),
		).toMatchObject({ ok: false, code: "private_address" });
	}
	// http to a non-loopback host stays refused even with the fixture exception.
	expect(
		await run(
			executor(
				connection({
					baseUrl: "http://example.com",
					allowHosts: ["example.com"],
				}),
			),
			getBinding(),
			{ itemId: "a" },
		),
	).toMatchObject({ ok: false, code: "insecure_transport" });
	expect(
		await run(
			executor(
				connection({
					baseUrl: "https://user:pw@example.com",
					allowHosts: ["example.com"],
				}),
			),
			getBinding(),
			{ itemId: "a" },
		),
	).toMatchObject({ ok: false, code: "invalid_binding" });
	const unknown = createHttpJsonExecutor({ connections: new Map() });
	expect(await run(unknown, getBinding(), { itemId: "a" })).toMatchObject({
		ok: false,
		code: "connection_unavailable",
	});
	expect(seen).toHaveLength(0);
});

test("GET is never retried; POST is resent only with a registered idempotency key", async () => {
	flaky = 0;
	seen.length = 0;
	const post = (retry: HttpJsonBindingV1["retry"]) =>
		getBinding({
			method: "POST",
			pathTemplate: "/orders",
			pathFields: {},
			bodyFields: { sku: { inputField: "sku" }, kind: { literal: "web" } },
			permission: "write",
			retry,
		});
	const input = z.strictObject({ sku: z.string() });
	const order = z.strictObject({ orderId: z.string() });
	const first = await run(
		executor(),
		post({ mode: "none" }),
		{ sku: "s1" },
		{ inputSchema: input, outputSchema: order },
	);
	expect(first).toMatchObject({
		ok: false,
		code: "upstream_server_error",
		attempts: 1,
	});
	expect(seen).toHaveLength(1);
	expect(JSON.parse(seen[0]!.body)).toEqual({ sku: "s1", kind: "web" });
	expect(seen[0]!.headers.get("content-type")).toBe("application/json");

	flaky = 0;
	seen.length = 0;
	const retrying = post({
		mode: "idempotency-key",
		header: "Idempotency-Key",
		maxAttempts: 2,
	});
	expect(
		await run(
			executor(),
			retrying,
			{ sku: "s1" },
			{ inputSchema: input, outputSchema: order },
		),
	).toMatchObject({ ok: false, code: "idempotency_key_required" });
	expect(seen).toHaveLength(0);
	const ok = await run(
		executor(),
		retrying,
		{ sku: "s1" },
		{ inputSchema: input, outputSchema: order, idempotencyKey: "evt-1" },
	);
	expect(ok).toEqual({ ok: true, value: { orderId: "o-1" }, attempts: 2 });
	expect(seen.map((s) => s.headers.get("idempotency-key"))).toEqual([
		"evt-1",
		"evt-1",
	]);

	// A GET binding with a key registered still sends once.
	const get = getBinding({
		retry: {
			mode: "idempotency-key",
			header: "Idempotency-Key",
			maxAttempts: 3,
		},
	});
	seen.length = 0;
	expect(
		await run(executor(), get, { itemId: "missing" }, { idempotencyKey: "k" }),
	).toMatchObject({ ok: false, attempts: 1 });
	expect(seen).toHaveLength(1);
	expect(seen[0]!.headers.get("idempotency-key")).toBeNull();
});

test("a GET binding with body fields and a mismatched path template are invalid bindings", async () => {
	expect(
		await run(executor(), getBinding({ bodyFields: { a: { literal: 1 } } }), {
			itemId: "a",
		}),
	).toMatchObject({ ok: false, code: "invalid_binding" });
	expect(
		await run(executor(), getBinding({ pathFields: {} }), { itemId: "a" }),
	).toMatchObject({ ok: false, code: "invalid_binding" });
});

const publicResolver = async () => [
	{ address: "93.184.216.34", family: 4 as const },
];
const refusedHosts = (
	resolver: () => Promise<{ address: string; family: 4 | 6 }[]>,
) => {
	let called = 0;
	const exec = createHttpJsonExecutor({
		connections: new Map([
			[
				"connection:fixture",
				connection({
					baseUrl: "https://api.example.com",
					allowHosts: ["api.example.com"],
				}),
			],
		]),
		resolver,
		fetch: (async () => {
			called++;
			return Response.json({ id: "x" });
		}) as unknown as typeof fetch,
	});
	return { exec, called: () => called };
};

test("a hostname that resolves to a private, loopback, link-local or mapped address is refused before any request", async () => {
	for (const address of [
		"10.0.0.8",
		"127.0.0.1",
		"169.254.169.254",
		"::1",
		"::ffff:127.0.0.1",
		"::ffff:7f00:1",
		"fd00::1",
	]) {
		const { exec, called } = refusedHosts(async () => [
			{ address, family: address.includes(":") ? 6 : 4 },
		]);
		expect(await run(exec, getBinding(), { itemId: "a" })).toMatchObject({
			ok: false,
			code: "private_address",
		});
		expect(called()).toBe(0);
	}
	// One private address among public ones is enough to refuse.
	const mixed = refusedHosts(async () => [
		{ address: "93.184.216.34", family: 4 },
		{ address: "10.0.0.8", family: 4 },
	]);
	expect(await run(mixed.exec, getBinding(), { itemId: "a" })).toMatchObject({
		code: "private_address",
	});
	expect(mixed.called()).toBe(0);
});

test("IPv4-mapped IPv6 literals in the base URL are refused", async () => {
	for (const baseUrl of [
		"https://[::ffff:127.0.0.1]",
		"https://[::ffff:a00:1]",
	]) {
		const host = new URL(baseUrl).hostname;
		expect(
			await run(
				executor(connection({ baseUrl, allowHosts: [host] })),
				getBinding(),
				{ itemId: "a" },
			),
		).toMatchObject({ ok: false, code: "private_address" });
	}
});

test("a hostname that resolves to a public address is requested", async () => {
	const { exec, called } = refusedHosts(publicResolver);
	expect(await run(exec, getBinding(), { itemId: "a" })).toMatchObject({
		ok: true,
	});
	expect(called()).toBe(1);
});
