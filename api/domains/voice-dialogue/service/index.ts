import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { DialogueService } from "../../dialogue";
import type { LarmPort } from "../../larm";
import type { VoiceTurn } from "../contracts";
import {
	activeIds,
	activeRunIds,
	get,
	insert,
	interrupt,
	lastSequence,
	update,
} from "../repository";

export function createVoiceDialogue(
	store: SqliteStore,
	dialogue: DialogueService,
	larm: LarmPort,
	clock: () => string = () => new Date().toISOString(),
) {
	const sessions = new Map<string, number>();
	const controllers = new Map<string, AbortController>();
	const audio = new Map<string, Uint8Array>();
	async function advance(
		id: string,
		status: VoiceTurn["status"],
		patch: { text?: string; runId?: string; error?: string } = {},
	) {
		return store.write((db) => {
			const current = get(db, id);
			return current
				? update(db, id, current.revision, status, clock(), patch)
				: false;
		});
	}
	async function process(
		turn: VoiceTurn,
		wav: Uint8Array,
		controller: AbortController,
	) {
		try {
			const text = await larm.transcribe(wav, controller.signal);
			if (!(await advance(turn.utteranceId, "responding", { text }))) return;
			const run = await dialogue.submit({
				requestId: turn.utteranceId,
				utteranceId: turn.utteranceId,
				conversationId: "main",
				text,
			});
			if (!(await advance(turn.utteranceId, "responding", { runId: run.id }))) {
				await dialogue.cancel(run.id);
				return;
			}
			const waitMs = run.deadlineAt
				? Math.max(0, Date.parse(run.deadlineAt) - Date.now()) + 10_000
				: undefined;
			const final = await dialogue.waitForTerminal(run.id, {
				signal: controller.signal,
				timeoutMs: waitMs,
			});
			if (controller.signal.aborted) return;
			if (final && ["queued", "running"].includes(final.status)) {
				// Stop waiting and make sure a late answer can never be adopted.
				await dialogue.cancel(run.id);
				throw new Error("dialogue_wait_timeout");
			}
			if (final?.status !== "completed" || !final.answerMessageId)
				throw new Error(final?.error ?? "dialogue_incomplete");
			const answer = dialogue.answerText(run.id);
			if (!answer) throw new Error("answer_missing");
			if (!(await advance(turn.utteranceId, "synthesizing"))) return;
			const wavOut = await larm.speak(answer, controller.signal);
			audio.set(turn.utteranceId, wavOut);
			if (!(await advance(turn.utteranceId, "ready"))) {
				audio.delete(turn.utteranceId);
				return;
			}
			const oldest = audio.keys().next().value;
			if (audio.size > 8 && oldest) {
				await store.write((db) => {
					const current = get(db, oldest);
					if (current?.status === "ready")
						update(db, oldest, current.revision, "failed", clock(), {
							error: "audio_evicted",
						});
				});
				audio.delete(oldest);
			}
		} catch (error) {
			audio.delete(turn.utteranceId);
			if (!controller.signal.aborted)
				await advance(turn.utteranceId, "failed", {
					error: error instanceof Error ? error.message : "voice_failed",
				}).catch(() => {});
		} finally {
			controllers.delete(turn.utteranceId);
		}
	}
	return {
		async recover() {
			// Stale turns are interrupted first, then their runs/jobs are cancelled so
			// a restarted backend never answers a voice turn nobody is listening to.
			const runIds = store.read((db) => activeRunIds(db));
			await store.write((db) => interrupt(db, clock()));
			for (const runId of runIds) await dialogue.cancel(runId);
		},
		start(sessionId: string, generation: number) {
			const previous = sessions.get(sessionId) ?? 0;
			if (generation <= previous) throw new Error("stale_voice_generation");
			sessions.set(sessionId, generation);
			return { sessionId, generation };
		},
		async accept(
			sessionId: string,
			generation: number,
			sequence: number,
			utteranceId: string,
			wav: Uint8Array,
		): Promise<VoiceTurn> {
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
				return { turn, fresh: true };
			});
			if (fresh) {
				const controller = new AbortController();
				controllers.set(utteranceId, controller);
				void process(turn, wav, controller);
			}
			return turn;
		},
		get(id: string) {
			return store.read((db) => get(db, id));
		},
		takeAudio(id: string) {
			const turn = store.read((db) => get(db, id));
			if (turn?.status !== "ready") return null;
			return audio.get(id) ?? null;
		},
		async played(id: string) {
			const updated = await store.write((db) => {
				const current = get(db, id);
				return current?.status === "ready"
					? update(db, id, current.revision, "played", clock())
					: false;
			});
			if (updated) audio.delete(id);
			return this.get(id);
		},
		async cancel(id: string) {
			const turn = store.read((db) => get(db, id));
			if (!turn) return null;
			await advance(id, "cancelled", { error: "cancel_requested" });
			controllers.get(id)?.abort();
			audio.delete(id);
			if (turn.runId) await dialogue.cancel(turn.runId);
			return this.get(id);
		},
		async stop(sessionId: string, generation: number) {
			if (sessions.get(sessionId) !== generation) return;
			sessions.delete(sessionId);
			const ids = store.read((db) => activeIds(db, sessionId, generation));
			await Promise.all(ids.map((id) => this.cancel(id)));
		},
		async close() {
			for (const c of controllers.values()) c.abort();
			controllers.clear();
			sessions.clear();
			audio.clear();
		},
	};
}
export type VoiceDialogueService = ReturnType<typeof createVoiceDialogue>;
