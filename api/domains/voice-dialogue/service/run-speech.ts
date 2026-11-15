import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { DialogueService } from "../../dialogue";
import type { InferencePort } from "../../inference";
import type { RunSpeechPlayed } from "../contracts";
import { createRunSpeechSession } from "./run-speech-session";

export type RunSpeechDeps = {
	store: SqliteStore;
	dialogue: DialogueService;
	larm: InferencePort;
	clock: () => string;
	externalActive: () => boolean;
	claim: (screenId: string, runId: string) => void;
};

/** Run-bound speech is ephemeral; stopping its reader never cancels the conversation. */
export function createRunSpeech(deps: RunSpeechDeps) {
	const sessions = new Map<string, ReturnType<typeof createRunSpeechSession>>();
	return {
		open(runId: string, screenId: string, signal: AbortSignal) {
			signal.throwIfAborted();
			if (deps.externalActive()) throw new Error("live_legacy_voice_disabled");
			if (sessions.size >= 8) throw new Error("voice_audio_capacity");
			deps.claim(screenId, runId);
			const id = crypto.randomUUID();
			const session = createRunSpeechSession(deps, {
				id,
				runId,
				screenId,
				signal,
				remove: () => sessions.delete(id),
			});
			sessions.set(id, session);
			return session;
		},
		async played(runId: string, id: string, input: RunSpeechPlayed) {
			const session = sessions.get(id);
			if (
				!session ||
				session.runId !== runId ||
				session.screenId !== input.screenId
			)
				throw new Error("speech_session_stale");
			await session.played(input);
		},
		close() {
			for (const session of sessions.values()) session.close("shutdown");
			sessions.clear();
		},
	};
}
