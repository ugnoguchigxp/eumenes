import { createSpeechSynthesis } from "./synthesis";
import { createVoiceIntake } from "./intake";
import { createVoiceResponder } from "./respond";
import { createInputCollector } from "./input";
import type { Database } from "bun:sqlite";
import type { Speech } from "./speech-state";
import type { SpeechPreparation } from "../../delivery";
import { getLogger } from "../../../infrastructure/logger";
import { toErrorCode } from "../../../infrastructure/error-code";
const log = getLogger("voice-dialogue");
import { SpeechSentences } from "./sentences";
import { spokenText } from "./spoken-text";
import { recordPlayed } from "./playback";
import { connectAnnouncementDelivery } from "./announcement-delivery";

import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { DialogueService } from "../../dialogue";
import type { InferencePort, SpeechOverride } from "../../inference";
import type { VoiceTurn } from "../contracts";
import { activeIds, activeRunIds, get, interrupt, update } from "../repository";

function audibleRun(run: ReturnType<DialogueService["get"]>) {
	return (
		!!run &&
		(["running", "completed"].includes(run.status) ||
			(run.status === "queued" && !!run.announcement))
	);
}

export function createVoiceDialogue(
	store: SqliteStore,
	dialogue: DialogueService,
	larm: InferencePort,
	clock: () => string = () => new Date().toISOString(),
) {
	const sessions = new Map<string, number>();
	const controllers = new Map<string, AbortController>();

	const audio = new Map<string, Speech>();
	const disconnectAnnouncementDelivery = connectAnnouncementDelivery(
		store,
		dialogue,
		larm,
		audio,
	);
	const previews = new Map<
		string,
		{ sessionId: string; controller: AbortController }
	>();
	const warming = new Map<string, AbortController>();
	const sessionUsed = new Map<string, number>();
	const MAX_AUDIO = 8;
	const AUDIO_STALE_MS = 600_000;
	const SESSION_IDLE_MS = 1_800_000;
	function canSpeak(id: string, runId: string, signal: AbortSignal) {
		if (signal.aborted) return false;
		const turn = store.read((db) => get(db, id));
		const run = dialogue.get(runId);
		if (
			!turn ||
			!["responding", "synthesizing", "ready"].includes(turn.status) ||
			!audibleRun(run)
		)
			return false;
		const refs = store.read((db) => ({
			asr: larm.requestFor?.(db, id, "asr"),
			llm: larm.requestFor?.(db, runId, "llm"),
		}));
		return !!(
			(!refs.asr || larm.validRequest?.(refs.asr)) &&
			(!refs.llm ||
				(larm.liveRequest?.(refs.llm) ?? larm.validRequest?.(refs.llm)))
		);
	}
	const LIVE_STATUSES = ["responding", "synthesizing", "ready"];
	/** Frees one audio slot: a finished entry first, then a stale waiting one; else refuses. */
	function makeRoomForSpeech() {
		if (audio.size < MAX_AUDIO) return;
		const nowMs = Date.parse(clock());
		let finished: string | undefined;
		let stale: string | undefined;
		for (const [key, entry] of audio) {
			const turn = store.read((db) => get(db, key));
			if (!turn || !LIVE_STATUSES.includes(turn.status)) {
				finished = key;
				break;
			}
			if (!stale && nowMs - entry.createdAtMs >= AUDIO_STALE_MS) stale = key;
		}
		if (finished) {
			audio.delete(finished);
			return;
		}
		if (!stale) throw new Error("voice_audio_capacity");
		const victim = stale;
		audio.delete(victim);
		void store
			.write((db) => {
				const turn = get(db, victim);
				if (turn)
					update(db, victim, turn.revision, "failed", clock(), {
						error: "audio_evicted",
					});
			})
			.then(() => {
				const runId = store.read((db) => get(db, victim))?.runId;
				if (runId) return dialogue.cancel(runId);
			})
			.catch((error) =>
				log.warn(
					"voice.evict_failed",
					{ reason: toErrorCode(error, "evict_failed") },
					error,
				),
			);
		controllers.get(victim)?.abort();
	}
	function touchSession(sessionId: string) {
		const now = Date.parse(clock());
		sessionUsed.set(sessionId, now);
		for (const [id, usedAt] of sessionUsed) {
			if (id === sessionId || now - usedAt < SESSION_IDLE_MS) continue;
			const generation = sessions.get(id);
			if (
				generation !== undefined &&
				store.read((db) => activeIds(db, id, generation)).length
			)
				continue;
			sessions.delete(id);
			sessionUsed.delete(id);
			warming.get(id)?.abort();
			warming.delete(id);
		}
	}
	const createSpeech = createSpeechSynthesis({
		store,
		dialogue,
		larm,
		audio,
		clock,
		canSpeak,
		makeRoomForSpeech,
	});
	async function advance(
		id: string,
		status: VoiceTurn["status"],
		patch: { error?: string } = {},
	) {
		const result = await store.write((db) => {
			const current = get(db, id);
			if (
				status !== "failed" &&
				status !== "cancelled" &&
				larm.validInTransaction
			) {
				const parents = [
					larm.requestFor?.(db, id, "asr"),
					current?.runId ? larm.requestFor?.(db, current.runId, "llm") : null,
				];
				if (parents.some((ref) => ref && !larm.validInTransaction?.(db, ref)))
					throw new Error("permission_revoked");
			}
			return current
				? update(db, id, current.revision, status, clock(), patch)
				: false;
		});
		if (result) log.debug("voice.transition", { utteranceId: id, status });
		else log.debug("voice.transition_skipped", { utteranceId: id, status });
		return result;
	}
	function linkRunInTransaction(db: Database, id: string, runId: string) {
		const current = get(db, id);
		if (
			!current ||
			current.status !== "responding" ||
			sessions.get(current.sessionId) !== current.generation
		)
			throw new Error("voice_turn_inactive");
		if (current.runId === runId) return;
		if (!update(db, id, current.revision, "responding", clock(), { runId }))
			throw new Error("voice_turn_inactive");
	}
	const input = createInputCollector({
		store,
		larm,
		sessions,
		controllers,
		respond: createVoiceResponder({
			store,
			dialogue,
			larm,
			advance,
			createSpeech,
			audio,
			linkRunInTransaction,
		}),
		clock,
	});
	return {
		commit: input.commit,
		/** Splits finished answer text into speakable clauses for replay. */
		replaySentences(text: string) {
			return new SpeechSentences().append(spokenText(text), true);
		},
		/** Synthesizes one clause on demand; it is not tied to any voice turn. */
		async replayAudio(text: string, signal: AbortSignal) {
			if (!text.trim() || text.length > 400)
				throw new Error("replay_text_invalid");
			return larm.speak(text, signal);
		},
		async replaySpeech(text: string, signal: AbortSignal, runId?: string) {
			if (!text.trim() || text.length > 400)
				throw new Error("replay_text_invalid");
			if (runId) {
				const run = dialogue.get(runId);
				if (
					run?.status !== "completed" ||
					!new SpeechSentences()
						.append(spokenText(dialogue.answerText(runId) ?? ""), true)
						.includes(text)
				)
					throw new Error("replay_text_invalid");
			}
			const context = runId ? dialogue.answerContext?.(runId) : undefined;

			const replayRun = runId ? dialogue.get(runId) : undefined;
			const preparation: SpeechPreparation = {
				...(replayRun
					? {
							collection: {
								conversationId: replayRun.conversationId,
								turnId: replayRun.id,
								granularity: "answer",
								chunkOrder: null,
							},
						}
					: {}),
				...(context ? { context } : {}),
				deliveryScope: "chunk",
			};
			const speech = larm.speakWithDelivery
				? await larm.speakWithDelivery(text, signal, preparation)
				: { wav: await larm.speak(text, signal) };
			signal.throwIfAborted();
			if (runId && speech.delivery)
				await store.write((db) => {
					signal.throwIfAborted();
					dialogue.recordAnswerDeliveryInTransaction(
						db,
						runId,
						speech.delivery!,
					);
				});
			return speech;
		},
		/** Synthesizes a fixed sample with unsaved voice settings. */
		async sampleAudio(override: SpeechOverride, signal: AbortSignal) {
			return larm.speak(
				"こんにちは。これは音声のサンプルです。",
				signal,
				override,
			);
		},
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
			touchSession(sessionId);
			log.info("voice.session_started", { sessionId, generation });
			warming.get(sessionId)?.abort();
			const warm = new AbortController();
			warming.set(sessionId, warm);
			void larm
				.prepareVoice?.(warm.signal)
				.catch(() => {})
				.finally(() => {
					if (warming.get(sessionId) === warm) warming.delete(sessionId);
				});
			return { sessionId, generation };
		},
		accept: createVoiceIntake({
			store,
			larm,
			sessions,
			touchSession,
			clock,
			dispatch: (turn, wav) => {
				previews.get(turn.utteranceId)?.controller.abort();
				const controller = new AbortController();
				controllers.set(turn.utteranceId, controller);
				input.accept(turn, wav, controller);
			},
		}),

		async preview(
			sessionId: string,
			generation: number,
			id: string,
			wav: Uint8Array,
		) {
			touchSession(sessionId);
			if (sessions.get(sessionId) !== generation)
				throw new Error("voice_session_inactive");
			if (store.read((db) => get(db, id)))
				throw new Error("stale_voice_preview");
			if (
				[...previews.values()].some((p) => p.sessionId === sessionId) ||
				previews.size >= 32
			)
				throw new Error("voice_preview_busy");
			const controller = new AbortController();
			previews.set(id, { sessionId, controller });
			try {
				const text = await larm.transcribe(wav, controller.signal);
				controller.signal.throwIfAborted();

				if (
					sessions.get(sessionId) !== generation ||
					store.read((db) => get(db, id))
				)
					throw new Error("stale_voice_preview");
				return { utteranceId: id, text };
			} catch (error) {
				if (controller.signal.aborted) return { utteranceId: id, text: "" };
				throw error;
			} finally {
				if (previews.get(id)?.controller === controller) previews.delete(id);
			}
		},
		get(id: string) {
			const turn = store.read((db) => get(db, id));
			if (!turn) return null;
			const state = audio.get(id);
			return {
				...turn,
				audioChunks: [...(state?.chunks.values() ?? [])].map((c) => ({
					index: c.index,
					text: c.text,
					...(c.delivery ? { delivery: c.delivery } : {}),
				})),
				audioComplete: state?.finished ?? turn.status === "played",
				audioSkipped: state?.skipped ?? 0,
			};
		},
		takeAudio(id: string, index = 0) {
			const turn = store.read((db) => get(db, id));
			if (
				!turn ||
				!["responding", "synthesizing", "ready"].includes(turn.status) ||
				!turn.runId
			)
				return null;
			const chunk = audio.get(id)?.chunks.get(index);
			const refs = store.read((db) => ({
				asr: larm.requestFor?.(db, id, "asr"),
				llm: larm.requestFor?.(db, turn.runId!, "llm"),
			}));
			if (
				(refs.asr && !larm.validRequest?.(refs.asr)) ||
				(refs.llm &&
					!(larm.liveRequest?.(refs.llm) ?? larm.validRequest?.(refs.llm))) ||
				(chunk?.requestId && !larm.validRequest?.(chunk.requestId))
			)
				return null;
			return chunk?.wav ?? null;
		},
		async played(id: string, index = 0) {
			await recordPlayed(store, audio, id, index, clock);
			return this.get(id);
		},
		async cancel(id: string) {
			previews.get(id)?.controller.abort();
			if (!store.read((db) => get(db, id))) return null;
			await advance(id, "cancelled", { error: "cancel_requested" });
			// Read after the cancel commits: a run linked by an earlier queued write is visible.
			const latest = store.read((db) => get(db, id));
			controllers.get(id)?.abort();
			previews.get(id)?.controller.abort();
			audio.get(id)?.wake();
			await larm.cancelSubject?.(id);
			audio.delete(id);
			if (latest?.runId) await dialogue.cancel(latest.runId);
			return this.get(id);
		},
		async stop(sessionId: string, generation: number) {
			if (sessions.get(sessionId) !== generation) return;
			log.info("voice.session_stopping", { sessionId, generation });
			sessions.delete(sessionId);
			sessionUsed.delete(sessionId);
			warming.get(sessionId)?.abort();
			for (const p of previews.values())
				if (p.sessionId === sessionId) p.controller.abort();
			const ids = store.read((db) => activeIds(db, sessionId, generation));
			await Promise.all(ids.map((id) => this.cancel(id)));
			log.info("voice.session_stopped", {
				sessionId,
				generation,
				count: ids.length,
			});
		},
		async close() {
			disconnectAnnouncementDelivery?.();
			for (const c of controllers.values()) c.abort();
			controllers.clear();
			for (const p of previews.values()) p.controller.abort();
			previews.clear();
			for (const c of warming.values()) c.abort();
			warming.clear();
			for (const a of audio.values()) a.wake();
			sessions.clear();
			sessionUsed.clear();
			audio.clear();
		},
	};
}
export type VoiceDialogueService = ReturnType<typeof createVoiceDialogue>;
