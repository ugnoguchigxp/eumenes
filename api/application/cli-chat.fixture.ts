import type { Message } from "../domains/conversation/contracts";
import type { PublicSubmit, Run } from "../domains/dialogue/contracts";
import { createChatSession, type ChatMessage } from "../../cli/chat-session";

export const message = (
	id: string,
	text: string,
	role: Message["role"] = "assistant",
): Message => ({
	id,
	text,
	role,
	conversationId: "main",
	createdAt: "2026-10-31T00:00:00Z",
	runId: null,
});
export function fixture() {
	const lifetime = new AbortController();
	const shown: { message: ChatMessage; updated: boolean }[] = [];
	const errors: string[] = [];
	const submissions: PublicSubmit[] = [];
	let messages: Message[] = [];
	let listener: (() => void) | undefined;
	let unsubscribed = false;
	const client: Parameters<typeof createChatSession>[0]["client"] = {
		async runs() {
			return [];
		},
		async conversation(id) {
			return { id, revision: 0, messages: [...messages] };
		},
		subscribeChanges(next) {
			listener = () => next("change");
			return () => {
				listener = undefined;
				unsubscribed = true;
			};
		},
		async submit(input) {
			submissions.push(input);
			messages.push(message(`user-${submissions.length}`, input.text, "user"));
			listener?.();
			return {
				id: `run-${submissions.length}`,
				status: "queued",
				error: null,
			} as Run;
		},
		async watchRun(id, _signal, progress) {
			messages.push(
				message(`answer-${id}`, "制作を受け付けました。\n次の行も全文表示。"),
			);
			progress({ runId: id, status: "completed", text: "" });
		},
	};
	const session = createChatSession({
		client,
		conversationId: "main",
		signal: lifetime.signal,
		message: (message, updated) => shown.push({ message, updated }),
		error: (text) => errors.push(text),
	});
	return {
		client,
		session,
		lifetime,
		shown,
		errors,
		submissions,
		setMessages: (next: Message[]) => {
			messages = next;
		},
		change: () => listener?.(),
		get unsubscribed() {
			return unsubscribed;
		},
	};
}
