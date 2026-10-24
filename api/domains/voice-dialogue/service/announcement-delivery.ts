import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { DialogueService } from "../../dialogue";
import type { InferencePort } from "../../inference";
import type { Speech } from "./speech-state";
import { get } from "../repository";

/** Uses the existing player's acknowledgement; no timer substitutes for a spoken notice. */
export function connectAnnouncementDelivery(
	store: SqliteStore,
	dialogue: DialogueService,
	larm: InferencePort,
	audio: Map<string, Speech>,
) {
	return dialogue.setAnnouncementDelivery?.(async (run, signal) => {
		const id = run.utteranceId;
		if (!id) return "full";
		const snapshot = store.read((db) => larm.snapshotFor?.(db, id));
		// Not spoken: the text is shown whole.
		if (snapshot && !snapshot.voice.autoSpeak) return "full";
		const ready = () => {
			signal.throwIfAborted();
			const turn = store.read((db) => get(db, id));
			if (
				!turn ||
				turn.runId !== run.id ||
				!["responding", "synthesizing", "ready"].includes(turn.status)
			)
				throw new Error("voice_turn_inactive");
			return audio.get(id);
		};
		// A very fast fixture may publish before the responder installs its speech queue.
		// Its next commit (audio ready, failure or cancellation) resolves that race.
		const speech =
			ready() ??
			(await new Promise<Speech>((resolve, reject) => {
				let stop = () => {};
				const check = () => {
					try {
						const state = ready();
						if (!state) return;
						stop();
						signal.removeEventListener("abort", check);
						resolve(state);
					} catch (error) {
						stop();
						signal.removeEventListener("abort", check);
						reject(error);
					}
				};
				stop = store.onCommit(check);
				signal.addEventListener("abort", check, { once: true });
				check();
			}));
		try {
			await speech.waitForPlayback(signal);
			ready();
		} catch (error) {
			// Interrupted while it was played: what was heard counts (section 6.5); nothing heard is a failure.
			if (speech.played.length > 0 && !signal.aborted) return "partial";
			throw error;
		}
		return "full";
	});
}
