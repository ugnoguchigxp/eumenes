import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, expect, test } from "vitest";
import type {
	Run,
	Submit,
} from "../../../../../api/domains/dialogue/contracts";
import type { DialogueClient } from "../../../../../client/dialogue";
import { ApiConnectionError } from "../../../../../client/transport";
import { useSubmit } from "..";

const cleanup: Array<() => void> = [];
afterEach(() => {
	for (const close of cleanup.splice(0)) close();
});
function setup() {
	const accepted = new Map<string, Run>();
	let loseResponse = true;
	const api: DialogueClient = {
		identity: "http://127.0.0.1:8787",
		runs: async () => [...accepted.values()],
		watchRun: async () => {},
		run: async (id) => accepted.get(id)!,
		cancel: async (id) => accepted.get(id)!,
		async submit(input: Submit) {
			let run = accepted.get(input.requestId);
			if (run && run.inputMessageId !== input.text)
				throw new Error("request_conflict");
			if (!run) {
				run = {
					id: input.requestId,
					requestId: input.requestId,
					conversationId: input.conversationId,
					utteranceId: null,
					status: "queued",
					revision: 0,
					inputMessageId: input.text,
					answerMessageId: null,
					error: null,
					jobId: null,
					deadlineAt: null,
					sourceKind: "manual",
					scheduleId: null,
					occurrenceId: null,
					createdAt: "2026-10-08T00:00:00Z",
					updatedAt: "2026-10-08T00:00:00Z",
				};
				accepted.set(input.requestId, run);
			}
			if (loseResponse) {
				loseResponse = false;
				throw new ApiConnectionError();
			}
			return run;
		},
	};
	const cache = new QueryClient();
	const wrapper = ({ children }: PropsWithChildren) => (
		<QueryClientProvider client={cache}>{children}</QueryClientProvider>
	);
	const hook = renderHook(() => useSubmit(api, "main"), { wrapper });
	cleanup.push(() => {
		hook.unmount();
		cache.clear();
	});
	return {
		accepted,
		send: async (text: string) => {
			let run: Run | undefined;
			await act(async () => {
				run = await hook.result.current.mutateAsync(text);
			});
			return run!;
		},
	};
}
test("resending after a lost acknowledgement reuses the accepted run; a later send is new", async () => {
	const h = setup();
	await expect(h.send("こんにちは")).rejects.toThrow("api_connection_failed");
	expect(h.accepted.size).toBe(1);
	const originalId = [...h.accepted.keys()][0];
	const retried = await h.send("こんにちは");
	expect(retried.id).toBe(originalId);
	expect(h.accepted.size).toBe(1);
	const next = await h.send("こんにちは");
	expect(next.id).not.toBe(originalId);
	expect(h.accepted.size).toBe(2);
});
test("editing a message after an uncertain send starts a different request", async () => {
	const h = setup();
	await expect(h.send("最初のメッセージ")).rejects.toThrow(
		"api_connection_failed",
	);
	const changed = await h.send("編集したメッセージ");
	expect(changed.inputMessageId).toBe("編集したメッセージ");
	expect(h.accepted.size).toBe(2);
});
