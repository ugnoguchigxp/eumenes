import type { Dispatch, FormEvent, SetStateAction } from "react";
import type { useChatAttachments } from "./useChatAttachments";
import type { ChatFiles } from "./useChatFiles";
import type {
	Addressee,
	RunViewing,
} from "../../../api/domains/dialogue/contracts";
import type { useSubmit } from "../domains/dialogue";
export type ChatDraft = { text: string; dictated: boolean };

/** Accept exactly this draft; subsequent edits and added images survive the acknowledgement. */
export function chatSend(
	input: ChatDraft,
	setInput: Dispatch<SetStateAction<ChatDraft>>,
	images: ReturnType<typeof useChatAttachments>,
	files: ChatFiles,
	submit: ReturnType<typeof useSubmit>,
	automaticInput: boolean,
	watchRun: (id: string) => void,
	/** The saved item the focused screen shows when the message is sent, if any. */
	viewing: () => RunViewing | undefined = () => undefined,
	/** The addressee the user saw when sending; the host refuses if it changed since. */
	addressee: () => Addressee | undefined = () => undefined,
) {
	return (event: FormEvent) => {
		event.preventDefault();
		const text = input.text.trim();
		const carried = images.items.length + files.items.length;
		if (
			(!text && !carried) ||
			(automaticInput && !carried) ||
			submit.isPending ||
			images.busy ||
			files.busy
		)
			return;
		const snapshot = [...images.items];
		const fileSnapshot = [...files.items];
		// What is on screen now is what the message refers to, not what is shown after the upload.
		const shown = viewing();
		const sentTo = addressee();
		void Promise.all([images.upload(snapshot), files.upload(fileSnapshot)])
			.then(([attachmentIds, fileIds]) =>
				submit.mutateAsync({
					text,
					attachmentIds,
					...(fileIds.length ? { fileIds } : {}),
					...(shown ? { viewing: shown } : {}),
					...(sentTo ? { addressee: sentTo } : {}),
				}),
			)
			.then((run) => {
				images.clear(snapshot);
				files.clear(fileSnapshot);
				if (run?.id) watchRun(run.id);
				setInput((current) =>
					current === input ? { text: "", dictated: false } : current,
				);
			})
			.catch(() => {});
	};
}
