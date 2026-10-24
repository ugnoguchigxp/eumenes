import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, expect, test, vi } from "vitest";
import type { Message } from "../../../api/domains/conversation/contracts";
import type { Run } from "../../../api/domains/dialogue/contracts";
import type { DialogueClient } from "../../../client/dialogue";
import { ApiError } from "../../../client/transport";
import type { ChatDraft } from "./chat-send";
import { usePromptEdit } from "./usePromptEdit";

afterEach(cleanup);

const message = (id: string, extra: Partial<Message> = {}): Message => ({
	id,
	conversationId: "main",
	role: "user",
	text: `text-${id}`,
	createdAt: "2026-10-24T00:00:00Z",
	runId: `run-${id}`,
	...extra,
});
const run = (inputMessageId: string, extra: Partial<Run> = {}): Run => ({
	id: `run-${inputMessageId}-${extra.status ?? "running"}`,
	requestId: crypto.randomUUID(),
	conversationId: "main",
	utteranceId: null,
	status: "running",
	revision: 0,
	inputMessageId,
	answerMessageId: null,
	error: null,
	jobId: null,
	deadlineAt: null,
	sourceKind: "manual",
	scheduleId: null,
	occurrenceId: null,
	specialistSessionId: null,
	createdAt: "2026-10-24T00:00:00Z",
	updatedAt: "2026-10-24T00:00:00Z",
	...extra,
});

function setup(
	messages: Message[],
	runs: Run[],
	resubmit: DialogueClient["resubmit"] = async () => run("x"),
	recording = false,
) {
	const client = { identity: "test", resubmit } as unknown as DialogueClient;
	const cache = new QueryClient();
	const wrapper = ({ children }: PropsWithChildren) => (
		<QueryClientProvider client={cache}>{children}</QueryClientProvider>
	);
	let input: ChatDraft = { text: "書きかけ", dictated: false };
	const setInput = vi.fn((draft: ChatDraft) => {
		input = draft;
	});
	const watchRun = vi.fn();
	const hook = renderHook(
		() =>
			usePromptEdit({
				client,
				conversationId: "main",
				messages,
				runs,
				recording,
				input,
				setInput,
				watchRun,
			}),
		{ wrapper },
	);
	return { hook, setInput, watchRun, input: () => input };
}

const submitEvent = () =>
	({ preventDefault() {} }) as unknown as Parameters<
		ReturnType<typeof usePromptEdit>["send"]
	>[0];

test("only the latest typed or spoken utterance whose run is unanswered can be edited", () => {
	const latest = [message("a"), message("b")];
	expect(
		setup(latest, [run("a"), run("b")]).hook.result.current.target,
	).toMatchObject({ message: { id: "b" } });
	expect(
		setup(latest, [run("b", { status: "completed" })]).hook.result.current
			.target,
	).toBeNull();
	expect(
		setup(latest, [
			run("b", { status: "cancelled", error: "utterance_handled" }),
		]).hook.result.current.target,
	).toBeNull();
	expect(
		setup(latest, [run("b", { specialistSessionId: "s" })]).hook.result.current
			.target,
	).toBeNull();
	expect(
		setup(
			[message("a"), message("form", { presentation: "artifact" })],
			[run("a"), run("form")],
		).hook.result.current.target,
	).toBeNull();
	expect(
		setup(latest, [
			run("b", { status: "cancelled" }),
			run("notice", { status: "completed", sourceKind: "notice" }),
		]).hook.result.current.target,
	).toBeNull();
	// While the microphone records, there is no entry to the edit.
	expect(
		setup(latest, [run("b")], undefined, true).hook.result.current.target,
	).toBeNull();
});

test("an edit fills the composer, a stop restores the draft and an accepted send watches the new run", async () => {
	const resubmit = vi.fn(async () => run("b", { id: "next" }));
	const h = setup([message("b")], [run("b")], resubmit);
	act(() => h.hook.result.current.start());
	expect(h.hook.result.current.editing?.id).toBe("b");
	expect(h.input().text).toBe("text-b");
	act(() => h.hook.result.current.stop());
	expect(h.hook.result.current.editing).toBeNull();
	expect(h.input().text).toBe("書きかけ");
	act(() => h.hook.result.current.start());
	h.setInput({ text: " 直した ", dictated: false });
	h.hook.rerender();
	await act(async () => {
		h.hook.result.current.send(submitEvent());
	});
	expect(resubmit).toHaveBeenCalledWith(
		"main",
		"b",
		expect.objectContaining({ text: "直した" }),
	);
	await waitFor(() => expect(h.watchRun).toHaveBeenCalledWith("next"));
	expect(h.hook.result.current.editing).toBeNull();
	expect(h.input().text).toBe("書きかけ");
});

test("a refused edit keeps the edit state and says why", async () => {
	const h = setup([message("b")], [run("b")], async () => {
		throw new ApiError(409, "already_acted");
	});
	act(() => h.hook.result.current.start());
	await act(async () => {
		h.hook.result.current.send(submitEvent());
	});
	await waitFor(() =>
		expect(h.hook.result.current.error).toBe(
			"実行が始まっていたため編集できませんでした。",
		),
	);
	expect(h.hook.result.current.editing?.id).toBe("b");
});
