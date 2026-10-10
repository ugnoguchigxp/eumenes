import { describe, expect, it, vi } from "vitest";
import { contracts, newClient, stubFetch } from "./harness";

/** Records the AbortSignal each fetch received. */
function stubSignals(respond: () => Response) {
	const signals: (AbortSignal | null | undefined)[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url: URL, init: RequestInit = {}) => {
			signals.push(init.signal);
			return respond();
		}),
	);
	return signals;
}

const uuid1 = "11111111-1111-4111-8111-111111111111";
const uuid2 = "22222222-2222-4222-8222-222222222222";
const uuid3 = "33333333-3333-4333-8333-333333333333";
const t0 = "2026-10-10T00:00:00.000Z";

const view = {
	kind: "conversation_source",
	messageRef: uuid1,
	messageId: "m1",
	conversationId: "c1",
	speaker: "user",
	createdAt: t0,
	revision: "rev1",
	digest: "d1",
	viewId: uuid2,
	viewDigest: "vd1",
	start: 0,
	end: 5,
	text: "hello",
	truncated: false,
	nextCursor: null,
};
const scope = {
	conversationId: "c1",
	conversationRevision: 3,
	scopeRef: uuid3,
	scannedMessages: 1,
	scannedBytes: 5,
	scanComplete: true,
	expiresAt: t0,
};

// The history API server contract is owned by in-flight work; these cases pin
// what client/conversation.ts and the shared zod contracts say today.
contracts("history client", [
	{
		name: "historySearch",
		call: (c) =>
			c.historySearch("c/1", { query: "hello", speaker: "user", limit: 5 }),
		method: "POST",
		path: "/api/conversations/c%2F1/history/search",
		body: { query: "hello", speaker: "user", limit: 5 },
		response: { candidates: [view], cursor: null, scope },
	},
	{
		name: "historyRead",
		call: (c) => c.historyRead("c1", { messageRef: uuid1, before: 1 }),
		method: "POST",
		path: "/api/conversations/c1/history/read",
		body: { messageRef: uuid1, before: 1 },
		response: { messages: [view], scope },
	},
]);

describe("history client details", () => {
	it("historySearch drops unknown response fields and keeps the cursor", async () => {
		stubFetch(() =>
			Response.json({
				candidates: [],
				cursor: uuid1,
				scope: { ...scope, extra: 1 },
				extra: 1,
			}),
		);
		expect(await newClient().historySearch("c1", {})).toEqual({
			candidates: [],
			cursor: uuid1,
			scope,
		});
	});
	it("rejects a view that violates the schema", async () => {
		stubFetch(() =>
			Response.json({
				messages: [{ ...view, speaker: "system" }],
				scope,
			}),
		);
		await expect(
			newClient().historyRead("c1", { messageRef: uuid1 }),
		).rejects.toMatchObject({ name: "ZodError" });
	});
	it("sends the JSON content type and forwards the abort signal", async () => {
		const signals = stubSignals(() =>
			Response.json({ candidates: [], cursor: null, scope }),
		);
		const controller = new AbortController();
		await newClient().historySearch("c1", {}, controller.signal);
		expect(signals[0]).toBe(controller.signal);
	});
});

const summary = {
	key: "a".repeat(64),
	keywords: "weather tokyo",
	target: { name: "Tokyo", prefecture: "Tokyo", granularity: "city" },
	state: "active",
	stateToken: "b".repeat(64),
	activeVersionId: "v1",
	sourceUrl: "https://example.com/w",
	lastSuccessAt: 1,
	draftStatus: null,
};
const detail = { ...summary, skillRevision: null, contextProjection: null };
const keyed = `/api/research-routes/${summary.key}`;
const control = { requestId: uuid1, expectedStateToken: "b".repeat(64) };

// Research-route responses are handed through without a zod parse.
contracts("research-routes client", [
	{
		name: "researchRoutes",
		call: (c) => c.researchRoutes(),
		method: "GET",
		path: "/api/research-routes",
		response: { items: [summary], nextCursor: null, epoch: 0 },
		parsed: false,
	},
	{
		name: "researchRoutes with cursor and limit",
		call: (c) => c.researchRoutes({ cursor: "cur sor", limit: 20 }),
		method: "GET",
		path: "/api/research-routes?cursor=cur+sor&limit=20",
		response: { items: [], nextCursor: "next", epoch: 2 },
		parsed: false,
	},
	{
		name: "researchRoute",
		call: (c) => c.researchRoute(summary.key),
		method: "GET",
		path: keyed,
		response: detail,
		parsed: false,
	},
	{
		name: "editResearchRoute",
		call: (c) =>
			c.editResearchRoute(summary.key, { ...control, instruction: "use NHK" }),
		method: "POST",
		path: `${keyed}/edits`,
		body: { ...control, instruction: "use NHK" },
		response: { draftId: uuid2 },
		parsed: false,
	},
	{
		name: "disableResearchRoute",
		call: (c) => c.disableResearchRoute(summary.key, control),
		method: "POST",
		path: `${keyed}/disable`,
		body: control,
		response: { ...detail, state: "disabled" },
		parsed: false,
	},
	{
		name: "rediscoverResearchRoute",
		call: (c) => c.rediscoverResearchRoute(summary.key, control),
		method: "POST",
		path: `${keyed}/rediscover`,
		body: control,
		response: { ...detail, state: "preparing" },
		parsed: false,
	},
	{
		name: "clearResearchRoutes",
		call: (c) => c.clearResearchRoutes({ requestId: uuid1, expectedEpoch: 4 }),
		method: "POST",
		path: "/api/research-routes/clear",
		body: { requestId: uuid1, expectedEpoch: 4 },
		response: { epoch: 5, deletedKeys: 3 },
		parsed: false,
	},
]);

describe("research-routes client details", () => {
	it("encodes the key into the path segment", async () => {
		const seen = stubFetch(() => Response.json(detail));
		await newClient().researchRoute("a/b?c");
		expect(seen[0]?.path).toBe("/api/research-routes/a%2Fb%3Fc");
	});
	it("posts JSON content type and omits empty query parameters", async () => {
		const seen = stubFetch(() => Response.json({ epoch: 1, deletedKeys: 0 }));
		await newClient().clearResearchRoutes({
			requestId: uuid1,
			expectedEpoch: 0,
		});
		expect(seen[0]?.headers["content-type"]).toBe("application/json");
		stubFetch(() => Response.json({ items: [], nextCursor: null, epoch: 0 }));
		const list = stubFetch(() =>
			Response.json({ items: [], nextCursor: null, epoch: 0 }),
		);
		await newClient().researchRoutes({ limit: 0 });
		expect(list[0]?.path).toBe("/api/research-routes?limit=0");
	});
	it("combines the caller's signal with a timeout", async () => {
		const signals = stubSignals(() => Response.json(detail));
		const controller = new AbortController();
		await newClient().researchRoute(summary.key, controller.signal);
		await newClient().researchRoute(summary.key);
		expect(signals[0]).not.toBe(controller.signal);
		controller.abort();
		expect(signals[0]?.aborted).toBe(true);
		expect(signals[1]?.aborted).toBe(false);
	});
	it("maps a non-JSON error body to an HTTP status message", async () => {
		stubFetch(() => new Response("boom", { status: 502 }));
		await expect(newClient().researchRoutes()).rejects.toMatchObject({
			status: 502,
			message: "HTTP 502",
		});
	});
});

describe("binary and stream clients: auth header", () => {
	it("voiceAudio without an index, serviceArtifact and watchRun send the bearer token", async () => {
		const bytes = stubFetch(() => new Response(new Uint8Array([1])));
		await newClient().voiceAudio("u1");
		expect(bytes[0]?.path).toBe("/api/voice/turns/u1/audio");
		expect(bytes[0]?.headers.authorization).toBe("Bearer test-token");
		const art = stubFetch(() => new Response("x"));
		await newClient().serviceArtifact("sr1");
		expect(art[0]?.headers.authorization).toBe("Bearer test-token");
		const sse = stubFetch(
			() =>
				new Response(
					`data: ${JSON.stringify({ runId: "r1", status: "completed", text: "" })}\n\n`,
					{ headers: { "Content-Type": "text/event-stream" } },
				),
		);
		await newClient().watchRun("r1", new AbortController().signal, () => {});
		expect(sse[0]?.headers.authorization).toBe("Bearer test-token");
	});
});
