import { useMemo, useRef, useState, type FormEvent } from "react";
import type { Message } from "../../../api/domains/conversation/contracts";
import type { Run } from "../../../api/domains/dialogue/contracts";
import type { DialogueClient } from "../../../client/dialogue";
import { ApiError } from "../../../client/transport";
import { describeError } from "../errorMessages";
import { useResubmit } from "../domains/dialogue";
import type { ChatDraft } from "./chat-send";

const EDITABLE = ["queued", "running", "cancelled"];

/** Why the host refused the edit, as the banner says it (the prompt edit design, section 5.3). */
function refusal(error: unknown) {
	if (!(error instanceof ApiError))
		return `送信できませんでした: ${describeError(error)}`;
	if (error.message === "already_acted")
		return "実行が始まっていたため編集できませんでした。";
	if (error.message === "not_latest")
		return "新しい発言があるため、この発言は編集できません。";
	return "この発言は編集できません。";
}

/**
 * The latest utterance's edit: which message may be edited, the composer's edit state and the send that
 * answers it again. The host decides at the send; this only hides the entry where it is sure to be refused.
 */
export function usePromptEdit({
	client,
	conversationId,
	messages,
	runs,
	recording,
	input,
	setInput,
	watchRun,
}: {
	client: DialogueClient;
	conversationId: string;
	messages: Message[] | undefined;
	runs: Run[] | undefined;
	recording: boolean;
	input: ChatDraft;
	setInput: (draft: ChatDraft) => void;
	watchRun: (id: string) => void;
}) {
	const resubmit = useResubmit(client, conversationId);
	const [editing, setEditing] = useState<Message | null>(null);
	const saved = useRef<ChatDraft>({ text: "", dictated: false });
	const target = useMemo(() => {
		const latest = messages?.filter((m) => m.role === "user").at(-1);
		if (!latest || (latest.presentation ?? "conversation") !== "conversation")
			return null;
		const at = runs
			? runs.map((r) => r.inputMessageId).lastIndexOf(latest.id)
			: -1;
		const run = at < 0 ? undefined : runs![at];
		// A later answered run handled the stopped utterance with it: it stays as said.
		const handled = runs?.slice(at + 1).some((r) => r.status === "completed");
		return run &&
			!handled &&
			EDITABLE.includes(run.status) &&
			run.error !== "utterance_handled" &&
			(run.sourceKind === "manual" || run.sourceKind === "voice") &&
			!run.specialistSessionId &&
			!run.pinnedToolchainId
			? { message: latest, run }
			: null;
	}, [messages, runs]);
	/** Messages sent more than once: each send after the first was an edit. */
	const editedIds = useMemo(() => {
		const seen = new Set<string>();
		const edited = new Set<string>();
		for (const run of runs ?? [])
			if (seen.has(run.inputMessageId)) edited.add(run.inputMessageId);
			else seen.add(run.inputMessageId);
		return edited;
	}, [runs]);
	function start() {
		if (!target || editing) return;
		saved.current = input;
		resubmit.reset();
		setEditing(target.message);
		setInput({ text: target.message.text, dictated: false });
	}
	function stop() {
		if (!editing) return;
		setEditing(null);
		resubmit.reset();
		setInput(saved.current);
	}
	function send(event: FormEvent) {
		event.preventDefault();
		const text = input.text.trim();
		if (!editing || !text || resubmit.isPending) return;
		void resubmit
			.mutateAsync({ messageId: editing.id, text })
			.then((run) => {
				watchRun(run.id);
				setEditing(null);
				setInput(saved.current);
			})
			.catch(() => {});
	}
	return {
		/** The latest utterance and its run, while an edit can still be accepted. */
		target: recording ? null : target,
		editing,
		editedIds,
		pending: resubmit.isPending,
		error: resubmit.isError ? refusal(resubmit.error) : null,
		start,
		stop,
		send,
	};
}
