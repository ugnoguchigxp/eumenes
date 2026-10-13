import type { Dispatch, FormEvent, SetStateAction } from "react";
import type { useChatAttachments } from "./useChatAttachments";
import type { useSubmit } from "../domains/dialogue";
export type ChatDraft = { text: string; dictated: boolean };

/** Accept exactly this draft; subsequent edits and added images survive the acknowledgement. */
export function chatSend(
	input: ChatDraft,
	setInput: Dispatch<SetStateAction<ChatDraft>>,
	images: ReturnType<typeof useChatAttachments>,
	submit: ReturnType<typeof useSubmit>,
	automaticInput: boolean,
	watchRun: (id: string) => void,
) {
	return (event: FormEvent) => {
		event.preventDefault();
		const text = input.text.trim();
		if (
			(!text && !images.items.length) ||
			(automaticInput && !images.items.length) ||
			submit.isPending ||
			images.busy
		)
			return;
		const snapshot = [...images.items];
		void images
			.upload(snapshot)
			.then((attachmentIds) => submit.mutateAsync({ text, attachmentIds }))
			.then((run) => {
				images.clear(snapshot);
				if (run?.id) watchRun(run.id);
				setInput((current) =>
					current === input ? { text: "", dictated: false } : current,
				);
			})
			.catch(() => {});
	};
}
