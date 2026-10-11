import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { InferencePort } from "../../inference";
import type { VoiceTurn } from "../contracts";
import { get, insert, lastSequence } from "../repository";
export function createVoiceIntake({
	store,
	larm,
	sessions,
	touchSession,
	dispatch,
	clock,
}: {
	store: SqliteStore;
	larm: InferencePort;
	sessions: Map<string, number>;
	touchSession: (id: string) => void;
	clock: () => string;
	dispatch: (turn: VoiceTurn, wav: Uint8Array, deferred: boolean) => void;
}) {
	return async function accept(
		sessionId: string,
		generation: number,
		sequence: number,
		utteranceId: string,
		wav: Uint8Array,
		deferred = false,
	): Promise<VoiceTurn> {
		touchSession(sessionId);
		if (sessions.get(sessionId) !== generation)
			throw new Error("voice_session_inactive");
		if (!Number.isSafeInteger(sequence) || sequence <= 0)
			throw new Error("voice_sequence_invalid");
		if (
			wav.length < 44 ||
			wav.length > 4_000_000 ||
			new TextDecoder().decode(wav.subarray(0, 4)) !== "RIFF" ||
			new TextDecoder().decode(wav.subarray(8, 12)) !== "WAVE"
		)
			throw new Error("invalid_wav");
		const { turn, fresh } = await store.write((db) => {
			if (sessions.get(sessionId) !== generation)
				throw new Error("voice_session_inactive");
			const existing = get(db, utteranceId);
			if (existing) {
				if (
					existing.sessionId !== sessionId ||
					existing.generation !== generation ||
					existing.sequence !== sequence
				)
					throw new Error("voice_utterance_conflict");
				return { turn: existing, fresh: false };
			}
			if (sequence !== lastSequence(db, sessionId, generation) + 1)
				throw new Error("voice_sequence_out_of_order");
			const turn: VoiceTurn = {
				utteranceId,
				sessionId,
				generation,
				sequence,
				status: "recognizing",
				text: null,
				runId: null,
				error: null,
				revision: 0,
			};
			insert(db, turn, clock());
			const snapshot = larm.snapshotInTransaction?.(db);
			for (const purpose of ["asr", "llm", "tts"] as const)
				larm.captureInTransaction?.(
					db,
					utteranceId,
					purpose,
					Date.now() + 270_000,
					snapshot,
				);
			return { turn, fresh: true };
		});
		if (fresh) dispatch(turn, wav, deferred);
		return turn;
	};
}
