import { afterEach, expect, test } from "bun:test";
import { waitFor } from "../../../infrastructure/wait-for";
import { reply, setup, type Harness } from "./generation.fixture";

let h: Harness | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

/**
 * Two utterances of one conversation: the second is sent while the reply to the first is written. `taken` is what the
 * agency reports a model call of that reply took (eumenes-steer).
 */
async function twoUtterances(taken: string[]) {
	h = await setup({
		autoStart: false,
		agency: {
			workChangedInTransaction: () => {},
			steeredInTransaction: () => taken,
		},
	});
	let release!: () => void;
	h.state.gate = new Promise<void>((resolve) => (release = resolve));
	h.state.steps.push(...reply("一つ目への返事。"));
	const first = await h.dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text: "一つ目",
	});
	h.start();
	await waitFor(() => h!.dialogue.get(first.id)?.status === "running");
	const second = await h.dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text: "二つ目",
	});
	return { first, second, release };
}

test("an utterance a model call of the reply took is answered with it: no second run answers it", async () => {
	const taken: string[] = [];
	const { first, second, release } = await twoUtterances(taken);
	taken.push(second.inputMessageId);
	release();
	await waitFor(() => h!.dialogue.get(first.id)?.status === "completed");
	await waitFor(() => h!.dialogue.get(second.id)?.status === "cancelled");
	expect(h!.dialogue.get(second.id)?.error).toBe("utterance_handled");
	expect(h!.state.calls).toHaveLength(1);
	// It joined the log with the reply, handled; nothing is left pending.
	expect(h!.log().map((e) => h!.fields(e).text)).toContain("二つ目");
	expect(
		h!.store.read((db) =>
			h!.continuity.events.pendingInTransaction(db, "main"),
		),
	).toHaveLength(0);
});

test("an utterance no model call took gets its own reply", async () => {
	const { first, second, release } = await twoUtterances([]);
	h!.state.steps.push(...reply("二つ目への返事。"));
	release();
	await waitFor(() => h!.dialogue.get(first.id)?.status === "completed");
	await waitFor(() => h!.dialogue.get(second.id)?.status === "completed");
	expect(h!.state.calls).toHaveLength(2);
	expect(h!.dialogue.answerText(second.id)).toBe("二つ目への返事。");
});

test("what the agency gave the reply is gone by adoption: the reply is written again once, then not adopted", async () => {
	let complete = false;
	h = await setup({
		agency: {
			workChangedInTransaction: () => {},
			replyInputInTransaction: () => ({ sources: ["gone"], complete }),
		},
	});
	h.state.steps.push(...reply("一度目。"), ...reply("二度目。"));
	// Incomplete at adoption: written again with the host's note, and incomplete again: it fails.
	const failed = await h.say("こんにちは", "failed");
	expect(failed.error).toBe("memory_stale");
	expect(h.state.calls).toHaveLength(2);
});

test("a reply whose given input is whole is adopted", async () => {
	h = await setup({
		agency: {
			workChangedInTransaction: () => {},
			replyInputInTransaction: () => ({ sources: ["kept"], complete: true }),
		},
	});
	h.state.steps.push(...reply("お答えします。"));
	const run = await h.say("こんにちは");
	expect(h.dialogue.answerText(run.id)).toBe("お答えします。");
});

test("the non-streaming call answers over the call's own messages (steered words and the agency's state)", async () => {
	const seen: string[] = [];
	h = await setup({
		conversationAgent: {
			system: () => ({ base: "" }),
			async respond(input) {
				const reply = await (
					await import("eumenes-agency")
				).runRespond({
					...input,
					emotion: false,
					chat: {
						complete: (request, onDelta, signal) =>
							input.chat.complete(
								{
									tools: [...request.tools],
									messages: [
										...request.messages.map((m) => ({
											...m,
											...(m.tool_calls
												? { tool_calls: [...m.tool_calls] }
												: {}),
										})),
										{ role: "user" as const, content: "steered words" },
									] as never,
								},
								onDelta,
								signal,
							),
					},
				});
				return { text: reply.text, ended: reply.ended };
			},
		},
	});
	(h.larm as unknown as Record<string, unknown>).executeStream = undefined;
	(h.larm as unknown as Record<string, unknown>).answer = async (
		messages: Array<{ content: string }>,
	) => {
		seen.push(messages.map((m) => m.content).join("\n"));
		return "答えました。";
	};
	const run = await h.say("やあ");
	expect(h.dialogue.answerText(run.id)).toBe("答えました。");
	expect(seen).toHaveLength(1);
	expect(seen[0]).toContain("steered words");
});
