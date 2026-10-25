import { expect, test } from "bun:test";
import { createApp } from "../app";
import { createDocling, registerDocling } from "../../domains/docling";

test("disconnecting a real HTTP client aborts the gateway request and frees the open guard", async () => {
	const started = Promise.withResolvers<void>(),
		aborted = Promise.withResolvers<void>();
	let calls = 0;
	const service = createDocling({
		connection: () => ({
			revision: 1,
			version: "v1",
			gatewayUrl: "http://127.0.0.1:28765",
			publicOrigin: "http://localhost:28765",
			credential: "fixture-only",
		}),
		status: () => ({
			revision: 1,
			configured: true,
			publicOrigin: "http://localhost:28765",
		}),
		fetch: async (_url, init) => {
			if (++calls > 1)
				return Response.json({
					url: `/auth/exchange?ticket=${"t".repeat(43)}`,
					expires_in: 60,
				});
			return new Promise<Response>((_resolve, reject) => {
				init.signal!.addEventListener(
					"abort",
					() => {
						aborted.resolve();
						reject(new Error("fixture-aborted"));
					},
					{ once: true },
				);
				started.resolve();
			});
		},
	});
	const app = createApp({
		token: "fixture-eumenes-api-token",
		origin: "http://127.0.0.1:5173",
		modules: [{ mount: (hono) => registerDocling(hono, service) }],
	});
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: app.fetch,
	});
	const controller = new AbortController();
	try {
		const url = `http://127.0.0.1:${server.port}/api/docling/ui-tickets`,
			headers = { Authorization: "Bearer fixture-eumenes-api-token" };
		const pending = fetch(url, {
			method: "POST",
			headers,
			signal: controller.signal,
		}).catch(() => null);
		await started.promise;
		controller.abort();
		await pending;
		expect(
			await Promise.race([
				aborted.promise.then(() => true),
				Bun.sleep(1000).then(() => false),
			]),
		).toBe(true);
		const reopened = await fetch(url, {
			method: "POST",
			headers,
			signal: AbortSignal.timeout(1000),
		});
		expect(reopened.status).toBe(200);
		await reopened.body?.cancel();
		expect(calls).toBe(2);
	} finally {
		controller.abort();
		await server.stop(true);
	}
});

test("Bun applies the route's timeout while waiting beyond the server default", async () => {
	const service = createDocling({
		connection: () => ({
			revision: 1,
			version: "v1",
			gatewayUrl: "http://127.0.0.1:28765",
			publicOrigin: "http://localhost:28765",
			credential: "fixture-only",
		}),
		status: () => ({
			revision: 1,
			configured: true,
			publicOrigin: "http://localhost:28765",
		}),
		fetch: async () => {
			await Bun.sleep(1500);
			return Response.json({
				url: `/auth/exchange?ticket=${"t".repeat(43)}`,
				expires_in: 60,
			});
		},
	});
	const app = createApp({
		token: "fixture-eumenes-api-token",
		origin: "http://127.0.0.1:5173",
		modules: [{ mount: (hono) => registerDocling(hono, service) }],
	});
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 1,
		fetch: app.fetch,
	});
	try {
		const r = await fetch(
			`http://127.0.0.1:${server.port}/api/docling/ui-tickets`,
			{
				method: "POST",
				headers: { Authorization: "Bearer fixture-eumenes-api-token" },
				signal: AbortSignal.timeout(5000),
			},
		);
		expect(r.status).toBe(200);
		await r.body?.cancel();
	} finally {
		await server.stop(true);
	}
});

test("authenticated ticket API keeps secrets out of status, applies a per-request timeout and rejects foreign Origin", async () => {
	let posts = 0;
	const service = createDocling({
		connection: () => ({
			revision: 1,
			version: "v1",
			gatewayUrl: "http://127.0.0.1:28765",
			publicOrigin: "http://localhost:28765",
			credential: "fixture-long-term-larm-credential",
		}),
		status: () => ({
			revision: 1,
			configured: true,
			publicOrigin: "http://localhost:28765",
		}),
		fetch: (async () => {
			posts++;
			return Response.json({
				url: `/auth/exchange?ticket=${"t".repeat(43)}`,
				expires_in: 60,
			});
		}) as import("../../domains/docling").DoclingFetch,
	});
	const app = createApp({
		token: "fixture-eumenes-api-token",
		origin: "http://127.0.0.1:5173",
		modules: [{ mount: (hono) => registerDocling(hono, service) }],
	});
	const path = "/api/docling/ui-tickets",
		headers = { Authorization: "Bearer fixture-eumenes-api-token" };
	expect((await app.request(path, { method: "POST" })).status).toBe(401);
	expect(
		(
			await app.request(path, {
				method: "POST",
				headers: { ...headers, Origin: "http://other.invalid" },
			})
		).status,
	).toBe(403);
	expect((await app.request("/api/docling/status", { headers })).status).toBe(
		200,
	);
	expect(posts).toBe(0);
	let timeout: number | undefined;
	const response = await app.request(
		path,
		{ method: "POST", headers },
		{
			timeout: (_r: Request, seconds: number) => {
				timeout = seconds;
			},
		},
	);
	expect(response.status).toBe(200);
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect(response.headers.get("x-frame-options")).toBe("DENY");
	expect(timeout).toBe(200);
	const value = await response.json();
	expect(
		value.url.startsWith("http://localhost:28765/auth/exchange?ticket="),
	).toBe(true);
	expect(JSON.stringify(value)).not.toContain(
		"fixture-long-term-larm-credential",
	);
	expect(posts).toBe(1);
});
