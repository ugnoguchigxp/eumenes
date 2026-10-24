import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	configureLogging,
	withLogContext,
} from "../../../infrastructure/logger";
import { countChatBody } from "../service/chat-input";
import { chatRequest } from "../service/chat-request";
import type { Provider } from "../service/profiles";
import { imageLarmFixture, imagePolicy } from "./chat-input.fixture";
import {
	lifecycleFixture,
	makeLarm,
	question,
	freshSignal,
} from "./larm.fixture";

let lines: string[];
beforeEach(() => {
	lines = [];
	configureLogging({
		level: "info",
		destination: {
			write: (line) => {
				lines.push(line);
			},
		},
	});
});
afterEach(() => configureLogging({ level: "silent" }));
const entries = () => lines.map((line) => JSON.parse(line));
const p: Provider = {
	name: "llm",
	baseUrl: "http://127.0.0.1:9998/v1",
	model: "fixture",
	protocol: "openai.chat-completions.v1",
	token: "PRIVATE_CREDENTIAL",
	chatInput: imagePolicy,
	contextWindow: {
		maxTokens: 262144,
		outputReserveTokens: 4096,
		safetyMarginTokens: 1976,
	},
};
const body = chatRequest(
	p,
	[{ role: "user", content: "PRIVATE_INPUT" }],
	false,
);
const serialized = JSON.stringify(body);
const upstreamId = "12345678-1234-4234-8234-123456789012";
const bootEpoch = `epoch-${upstreamId}`;
const configRevision = "a".repeat(64);
function success() {
	return {
		contractVersion: "larm-chat-input-token-count.v1",
		model: p.model,
		promptTokens: 10,
		textTokens: 10,
		imageTokens: 0,
		imageCount: 0,
		requestedOutputTokens: body.max_tokens,
		safetyMarginTokens: 1976,
		inputBudgetTokens: 262144 - body.max_tokens - 1976,
		maxContextTokens: 262144,
		fits: true,
		requestDigest: createHash("sha256").update(serialized).digest("hex"),
		runtime: "fixture",
		bootEpoch,
		configRevision,
		engineBuild: "fixture",
	};
}
function count(
	send: (url: URL, init: RequestInit) => Promise<Response>,
	signal = AbortSignal.timeout(2000),
) {
	return withLogContext(
		{
			runId: "fixture-run",
			attemptId: "fixture-attempt",
			connectionId: "fixture-connection",
			leaseExpiresAt: 2000000000000,
		},
		() => countChatBody(p, body, serialized, 0, signal, send),
	);
}

for (const status of [400, 401, 413, 503])
	test(`count rejection retains HTTP ${status} and safe correlation without inference or new headers`, async () => {
		let calls = 0;
		await expect(
			count(async (url, init) => {
				calls++;
				expect(url.href).toBe(
					"http://127.0.0.1:9998/v1/chat/completions/input-tokens",
				);
				expect(init.body).toBe(serialized);
				expect(Object.keys(init.headers!)).toEqual([
					"Authorization",
					"Content-Type",
				]);
				return Response.json(
					{
						error: {
							code: "unauthorized",
							message: "PRIVATE_RESPONSE",
							bootEpoch,
							configRevision,
						},
						body: "PRIVATE_INPUT",
					},
					{ status, headers: { "X-Request-Id": upstreamId } },
				);
			}),
		).rejects.toThrow("chat_token_count_unavailable");
		expect(calls).toBe(1);
		expect(entries().at(-1)).toMatchObject({
			event: "larm.token_count_failed",
			status,
			validationCode: "unauthorized",
			upstreamRequestId: upstreamId,
			connectionId: "fixture-connection",
			leaseExpiresAt: 2000000000000,
			runId: "fixture-run",
			attemptId: "fixture-attempt",
			providerOrigin: "http://127.0.0.1:9998",
			route: "/v1/chat/completions/input-tokens",
			requestBytes: Buffer.byteLength(serialized),
			bootEpoch,
			configRevision,
			phase: "response_status",
		});
		for (const secret of ["PRIVATE_RESPONSE", "PRIVATE_INPUT", p.token])
			expect(lines.join("")).not.toContain(secret);
	});

test("unknown code, free text and credential copied into metadata are excluded", async () => {
	await expect(
		count(async () =>
			Response.json(
				{
					error: {
						code: p.token,
						message: "PRIVATE_RESPONSE",
						bootEpoch: p.token,
						configRevision: p.token,
					},
				},
				{ status: 401, headers: { "X-Request-Id": p.token } },
			),
		),
	).rejects.toThrow("chat_token_count_unavailable");
	expect(entries().at(-1)).toMatchObject({
		validationCode: "unknown",
		status: 401,
	});
	expect(entries().at(-1).upstreamRequestId).toBeUndefined();
	expect(lines.join("")).not.toContain(p.token);
	expect(lines.join("")).not.toContain("PRIVATE_RESPONSE");
});

for (const bad of ["PRIVATE_INVALID_JSON", "x".repeat(16385)])
	test(`unreadable rejection retains HTTP status with ${bad.length} bytes`, async () => {
		await expect(
			count(
				async () =>
					new Response(bad, {
						status: 503,
						headers: { "X-Request-Id": upstreamId },
					}),
			),
		).rejects.toThrow("chat_token_count_unavailable");
		expect(entries().at(-1)).toMatchObject({
			status: 503,
			upstreamRequestId: upstreamId,
			validationCode: "unavailable",
		});
		expect(lines.join("")).not.toContain(bad);
	});

test("successful count records epoch and budget, without the digest or request content", async () => {
	await count(async () =>
		Response.json(success(), { headers: { "X-Request-Id": upstreamId } }),
	);
	expect(entries().at(-1)).toMatchObject({
		event: "larm.token_count_completed",
		status: 200,
		promptTokens: 10,
		bootEpoch,
		configRevision,
	});
	expect(lines.join("")).not.toContain(success().requestDigest);
	expect(lines.join("")).not.toContain("PRIVATE_INPUT");
});

for (const [phase, response, error] of [
	[
		"response_json",
		() => new Response("PRIVATE_INVALID_JSON"),
		"chat_token_count_unavailable",
	],
	[
		"response_contract",
		() => Response.json({ ...success(), requestDigest: "0".repeat(64) }),
		"chat_token_count_unavailable",
	],
	[
		"input_budget",
		() => Response.json({ ...success(), fits: false }),
		"context_budget_exceeded",
	],
] as const)
	test(`${phase} is distinct from an HTTP refusal`, async () => {
		await expect(count(async () => response())).rejects.toThrow(error);
		expect(entries().at(-1)).toMatchObject({
			phase,
			status: 200,
			reason: error,
		});
	});

test("transport errors and cancelled diagnostic reads remain bounded and do not expose raw errors", async () => {
	await expect(
		count(async () => {
			throw new Error("PRIVATE_NETWORK_ERROR");
		}),
	).rejects.toThrow("PRIVATE_NETWORK_ERROR");
	expect(entries().at(-1)).toMatchObject({ phase: "transport" });
	expect(lines.join("")).not.toContain("PRIVATE_NETWORK_ERROR");
	const abort = new AbortController();
	const work = count(
		async () =>
			new Response(
				new ReadableStream({
					start() {
						abort.abort();
					},
				}),
				{ status: 401 },
			),
		abort.signal,
	);
	await expect(work).rejects.toThrow("chat_token_count_unavailable");
	expect(entries().at(-1)).toMatchObject({ reason: "cancelled", status: 401 });
});

test("the real port supplies the claim identity and retains failed count behavior", async () => {
	const f = imageLarmFixture({ countError: true });
	try {
		await expect(
			f.p.answer(
				[{ role: "user", content: "PRIVATE_INPUT" }],
				AbortSignal.timeout(2000),
			),
		).rejects.toThrow("chat_token_count_unavailable");
		expect(
			entries().find((x) => x.event === "larm.token_count_failed"),
		).toMatchObject({ connectionId: "vision-session", status: 503 });
		expect(f.requests.map((x) => x.operation)).toEqual(["count"]);
	} finally {
		await f.p.close();
	}
	expect(
		entries().find((x) => x.event === "larm.connection_released"),
	).toMatchObject({ connectionId: "vision-session", status: 204 });
});

test("a control-plane GET 410 identifies and replaces the old claim before inference", async () => {
	const fake = lifecycleFixture();
	let gone = false;
	const port = makeLarm(async (url, init) => {
		if (
			gone &&
			init?.method === "GET" &&
			new URL(String(url)).pathname.endsWith("/connection1")
		)
			return new Response(null, { status: 410 });
		return fake.fetcher(url, init);
	});
	try {
		await port.connect();
		gone = true;
		await Promise.all([port.connect(), port.connect(), port.connect()]);
		expect(
			entries().find((x) => x.event === "larm.control_rejected"),
		).toMatchObject({ connectionId: "connection1", status: 410 });
		expect(port.inspect?.().connectionId).toBe("connection2");
		expect(fake.generation()).toBe(2);
		expect(await port.answer(question, freshSignal())).toBe("承知しました");
	} finally {
		await port.close();
	}
});
