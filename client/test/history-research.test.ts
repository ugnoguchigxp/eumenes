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

const selection = {
	id: "s1",
	runId: "r1",
	conversationId: "c1",
	utteranceId: null,
	requestId: null,
	retrieval: "none",
	candidates: [],
	historyRefs: [],
	decision: "answer",
	toolchainId: null,
	toolchainRevisionId: null,
	functionName: null,
	request: null,
	repaired: false,
	taskId: null,
	outcome: null,
	outcomeCode: null,
	recipe: null,
	durationMs: null,
	createdAt: 1,
	settledAt: null,
};
describe("toolchain-history client", () => {
	it("lists selections with only the given filters", async () => {
		const seen = stubFetch(() =>
			Response.json({ items: [], nextCursor: null }),
		);
		await newClient().toolchainSelections({ runId: "r 1", limit: 20 });
		expect(seen[0]?.path).toBe(
			"/api/toolchain-history/selections?runId=r+1&limit=20",
		);
		await newClient().toolchainSelections();
		expect(seen[1]?.path).toBe("/api/toolchain-history/selections");
	});
	it("encodes ids into the path and posts recipe state as JSON", async () => {
		const seen = stubFetch(() => Response.json(selection));
		await newClient().toolchainSelection("a/b");
		expect(seen[0]?.path).toBe("/api/toolchain-history/selections/a%2Fb");
		stubFetch(() => Response.json({ ok: true }));
		const state = stubFetch(() => Response.json({ ok: true }));
		await newClient().setToolchainRecipeState("x/y", "disabled");
		expect(state[0]?.path).toBe("/api/toolchain-history/recipes/x%2Fy/state");
		expect(state[0]?.headers["content-type"]).toBe("application/json");
	});
	it("rejects a selection or recipe page that breaks the contract", async () => {
		stubFetch(() => Response.json({ items: [{ id: "s1" }], nextCursor: null }));
		await expect(newClient().toolchainSelections()).rejects.toMatchObject({
			name: "ZodError",
		});
		stubFetch(() => Response.json({ ok: false }));
		await expect(
			newClient().setToolchainRecipeState("r1", "active"),
		).rejects.toMatchObject({ name: "ZodError" });
	});
	it("combines the caller's signal with a timeout", async () => {
		const signals = stubSignals(() => Response.json({ items: [] }));
		const controller = new AbortController();
		await newClient().toolchainRecipes(undefined, controller.signal);
		expect(signals[0]).not.toBe(controller.signal);
		controller.abort();
		expect(signals[0]?.aborted).toBe(true);
	});
});

describe("binary and stream clients: auth header", () => {
	it("voiceAudio without an index and watchRun send the bearer token", async () => {
		const bytes = stubFetch(() => new Response(new Uint8Array([1])));
		await newClient().voiceAudio("u1");
		expect(bytes[0]?.path).toBe("/api/voice/turns/u1/audio");
		expect(bytes[0]?.headers.authorization).toBe("Bearer test-token");
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
