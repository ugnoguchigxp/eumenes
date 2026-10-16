import type { Dispatch, FormEvent, SetStateAction } from "react";
import type { useChatAttachments } from "./useChatAttachments";
import type {
	Addressee,
	Viewing,
} from "../../../api/domains/dialogue/contracts";
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
	/** The saved item the focused screen shows when the message is sent, if any. */
	viewing: () => Viewing | undefined = () => undefined,
	/** The addressee the user saw when sending; the host refuses if it changed since. */
	addressee: () => Addressee | undefined = () => undefined,
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
		// What is on screen now is what the message refers to, not what is shown after the upload.
		const shown = viewing();
		const sentTo = addressee();
		void images
			.upload(snapshot)
			.then((attachmentIds) =>
				submit.mutateAsync({
					text,
					attachmentIds,
					...(shown ? { viewing: shown } : {}),
					...(sentTo ? { addressee: sentTo } : {}),
				}),
			)
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
