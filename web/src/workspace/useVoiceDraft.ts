import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import type { useVoiceDialogue } from "../domains/voice-dialogue";
import type { ChatDraft } from "./chat-send";

/** The composer and recognizer share one owner; a typed edit retires the unsent recognition. */
export function useVoiceDraft(
	input: ChatDraft,
	setInput: Dispatch<SetStateAction<ChatDraft>>,
	voice: ReturnType<typeof useVoiceDialogue>,
	watchRun: (id: string) => void,
) {
	const runId = voice.turn?.runId;
	useEffect(() => {
		if (runId) watchRun(runId);
	}, [runId, watchRun]);
	const edited = useRef<string | null>(null);
	const id = voice.recognitionId;
	const text = voice.transcription?.text;
	const hold = voice.inputHold;
	const status = voice.inputStatus;
	useEffect(() => {
		if (hold === "edited") return;
		if (!id || !text || status === "sent") {
			// External recognition cancellation/acceptance clears only its own draft.
			// eslint-disable-next-line react/set-state-in-effect
			setInput((current) =>
				current.dictated ? { text: "", dictated: false } : current,
			);
			return;
		}
		if (edited.current !== id) setInput({ text, dictated: true });
	}, [id, text, hold, status, setInput]);
	return {
		automaticInput: input.dictated && voice.active && !hold,
		editInput(text: string) {
			if (voice.active || voice.recognitionId) voice.takeInputOwnership();
			edited.current = id;
			setInput({ text, dictated: false });
		},
	};
}
