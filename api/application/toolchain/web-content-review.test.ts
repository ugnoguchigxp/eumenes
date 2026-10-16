import { expect, test, mock } from "bun:test";
import type { SqliteStore } from "../../infrastructure/sqlite";
import type { InferenceService } from "../../domains/inference";
import { createWebReview } from "./web-content-review";
const input = {
	source: { kind: "web", trust: "untrusted" },
	requestedUse: "answer_with_citation",
	segments: [{ location: "hidden", text: "External source material." }],
	findings: [],
} as const;
function harness(
	resourceId: string | null = null,
	accepted = true,
	abort?: AbortController,
) {
	const store = {
		write: async (fn: (db: unknown) => unknown) => fn({}),
	} as unknown as SqliteStore;
	const capture = mock(() => "guard-control");
	const accept = mock(() => accepted);
	const cancel = mock(async () => {});
	const execute = mock(async () => {
		abort?.abort();
		return {
			requestId: "guard-control",
			attemptId: "attempt",
			value: '{"documentKind":"source_content","classifications":[]}',
		};
	});
	const inference = {
		snapshotInTransaction: () => ({ subagent: { resourceId } }),
		captureBackgroundControlInTransaction: capture,
		executeControl: execute,
		acceptInTransaction: accept,
		cancelSubject: cancel,
	} as unknown as InferenceService;
	return {
		review: createWebReview(store, inference),
		capture,
		accept,
		cancel,
		execute,
	};
}
test("web assessment uses the saved route in one isolated exact control task", async () => {
	for (const resourceId of [null, "saved-resource"]) {
		const h = harness(resourceId);
		expect((await h.review(input)).decision).toBe("source_content");
		const captured = h.capture.mock.calls[0] as unknown as [
			unknown,
			{ route: unknown; structuredOutput: boolean; maxOutputTokens: number },
		];
		expect(captured[1].route).toEqual(
			resourceId ? { resourceId } : "conversation",
		);
		expect(captured[1].structuredOutput).toBe(true);
		const execution = h.execute.mock.calls[0] as unknown as [
			string,
			{ role: string }[],
			AbortSignal,
			{ reasoningEffort: string },
			unknown,
		];
		expect(execution[1].map((m) => m.role)).toEqual(["system", "user"]);
		expect(execution[3].reasoningEffort).toBe("low");
		expect(execution[4]).toEqual({ sessionRole: "auxiliary" });
		expect(h.accept).toHaveBeenCalledTimes(1);
		expect(h.cancel).toHaveBeenCalledTimes(1);
	}
});
test("a rejected or cancelled inference receipt never clears the document", async () => {
	const rejected = harness(null, false);
	await expect(rejected.review(input)).rejects.toThrow("web_review_stale");
	const abort = new AbortController();
	const cancelled = harness(null, true, abort);
	await expect(
		cancelled.review({ ...input, signal: abort.signal }),
	).rejects.toBeDefined();
	expect(cancelled.accept).not.toHaveBeenCalled();
	expect(cancelled.cancel).toHaveBeenCalledTimes(1);
});
