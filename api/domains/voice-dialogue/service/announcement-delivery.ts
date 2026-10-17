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
		if (!id) return;
		const snapshot = store.read((db) => larm.snapshotFor?.(db, id));
		if (snapshot && !snapshot.voice.autoSpeak) return;
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
		await speech.waitForPlayback(signal);
		ready();
	});
}
