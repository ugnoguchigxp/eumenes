import { SpeechSentences } from "./sentences";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { DialogueService } from "../../dialogue";
import type { InferencePort, Receipt } from "../../inference";
import type { SpeechDelivery } from "../../delivery";
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
	larm: InferencePort,
	clock: () => string = () => new Date().toISOString(),
) {
	const sessions = new Map<string, number>();
	const controllers = new Map<string, AbortController>();
	type Chunk = {
		index: number;
		text: string;
		wav: Uint8Array;
		requestId?: string;
		delivery?: SpeechDelivery;
	};
	type Speech = {
		chunks: Map<number, Chunk>;
		finished: boolean;
		append: (text: string, final?: boolean) => void;
		work: Promise<void>;
		wake: () => void;
		error?: Error;
	};
	const audio = new Map<string, Speech>();
	const previews = new Map<
		string,
		{ sessionId: string; controller: AbortController }
	>();
	const warming = new Map<string, AbortController>();
	function canSpeak(id: string, runId: string, signal: AbortSignal) {
		if (signal.aborted) return false;
		const turn = store.read((db) => get(db, id));
		const run = dialogue.get(runId);
		if (
			!turn ||
			!["responding", "synthesizing", "ready"].includes(turn.status) ||
			!run ||
			!["running", "completed"].includes(run.status)
		)
			return false;
		const refs = store.read((db) => ({
			asr: larm.requestFor?.(db, id, "asr"),
			llm: larm.requestFor?.(db, runId, "llm"),
		}));
		return (
			(!refs.asr || larm.validRequest?.(refs.asr)) &&
			(!refs.llm ||
				(larm.liveRequest?.(refs.llm) ?? larm.validRequest?.(refs.llm)))
		);
	}
	function createSpeech(
		id: string,
		runId: string,
		controller: AbortController,
	): Speech {
		if (audio.size >= 8) {
			const oldest = audio.keys().next().value;
			if (oldest) {
				audio.delete(oldest);
				void store
					.write((db) => {
						const turn = get(db, oldest);
						if (turn)
							update(db, oldest, turn.revision, "failed", clock(), {
								error: "audio_evicted",
							});
					})
					.catch(() => {});
				controllers.get(oldest)?.abort();
				const runId = store.read((db) => get(db, oldest))?.runId;
				if (runId) void dialogue.cancel(runId).catch(() => {});
			}
		}
		const pending: string[] = [];
		const sentences = new SpeechSentences();
		let inputDone = false,
			index = 0;
		const wakes = new Set<() => void>();
		const wake = () => {
			for (const listener of wakes) listener();
			wakes.clear();
		};
		const state: Speech = {
			chunks: new Map(),
			finished: false,
			wake,
			work: Promise.resolve(),
			append(text, final = false) {
				if (state.error || controller.signal.aborted) return;
				pending.push(...sentences.append(text, final));
				inputDone = final;
				wake();
			},
		};
		audio.set(id, state);
		state.work = (async () => {
			while (!controller.signal.aborted) {
				if (pending.length && state.chunks.size < 3) {
					const text = pending.shift()!;
					if (!canSpeak(id, runId, controller.signal))
						throw new Error("permission_revoked");
					const n = index++;
					const requestId = larm.captureSpeechChunkInTransaction
						? await store.write((db) =>
								larm.captureSpeechChunkInTransaction!(db, id, n),
							)
						: undefined;
					const receipt =
						requestId && larm.executeRequest
							? await larm.executeRequest(requestId, text, controller.signal)
							: undefined;
					const wav = receipt
						? (receipt.value as Uint8Array)
						: await larm.speak(text, controller.signal);
					if (!canSpeak(id, runId, controller.signal))
						throw new Error("permission_revoked");
					const published = await store.write((db) => {
						const turn = get(db, id);
						if (
							!turn ||
							!["responding", "synthesizing", "ready"].includes(turn.status) ||
							controller.signal.aborted
						)
							return false;
						if (receipt && !larm.acceptInTransaction?.(db, receipt))
							throw new Error("permission_revoked");
						state.chunks.set(n, {
							index: n,
							text,
							wav,
							requestId,
							...(receipt?.delivery ? { delivery: receipt.delivery } : {}),
						});
						return update(db, id, turn.revision, turn.status, clock());
					});
					if (!published) {
						state.chunks.delete(n);
						return;
					}
					continue;
				}
				if (inputDone && !pending.length) {
					state.finished = true;
					return;
				}
				await new Promise<void>((resolve) => {
					const finish = () => {
						controller.signal.removeEventListener("abort", finish);
						wakes.delete(finish);
						resolve();
					};
					wakes.add(finish);
					controller.signal.addEventListener("abort", finish, { once: true });
					if (controller.signal.aborted) finish();
				});
			}
		})().catch((error) => {
			state.error = error instanceof Error ? error : new Error("tts_failed");
			pending.length = 0;
			state.chunks.clear();
			wake();
		});
		return state;
	}
	async function advance(
		id: string,
		status: VoiceTurn["status"],
		patch: { text?: string; runId?: string; error?: string } = {},
		receipt?: Receipt,
	) {
		return store.write((db) => {
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
				if (
					parents.some(
						(ref) =>
							ref &&
							ref !== receipt?.requestId &&
							!larm.validInTransaction?.(db, ref),
					)
				)
					throw new Error("permission_revoked");
			}
			if (
				receipt &&
				(!current ||
					[
						"cancelled",
						"interrupted",
						"failed",
						"played",
						"completed",
					].includes(current.status) ||
					!larm.acceptInTransaction?.(db, receipt))
			)
				throw new Error("permission_revoked");
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
		let stopProgress = () => {};
		try {
			const asrId = store.read((db) =>
				larm.requestFor?.(db, turn.utteranceId, "asr"),
			);
			const asrReceipt =
				asrId && larm.executeRequest
					? await larm.executeRequest(asrId, wav, controller.signal)
					: undefined;
			const text = asrReceipt
				? (asrReceipt.value as string)
				: await larm.transcribe(wav, controller.signal);
			if (controller.signal.aborted) return;
			if (
				!(await advance(turn.utteranceId, "responding", { text }, asrReceipt))
			)
				return;
			if (asrId && !larm.validRequest?.(asrId))
				throw new Error("permission_revoked");
			const submit = larm.bindInTransaction
				? (input: Parameters<typeof dialogue.submit>[0]) =>
						dialogue.submitVoice(input, turn.utteranceId)
				: dialogue.submit;
			const run = await submit({
				requestId: turn.utteranceId,
				utteranceId: turn.utteranceId,
				conversationId: "main",
				text,
			});
			if (!(await advance(turn.utteranceId, "responding", { runId: run.id }))) {
				await dialogue.cancel(run.id);
				return;
			}

			const snapshot = store.read((db) =>
				larm.snapshotFor?.(db, turn.utteranceId),
			);
			const autoSpeak = !snapshot || snapshot.voice.autoSpeak;
			let speech: Speech | undefined;
			if (autoSpeak) {
				await store.write((db) =>
					larm.skipInTransaction?.(db, turn.utteranceId, "tts"),
				);
				speech = createSpeech(turn.utteranceId, run.id, controller);
				stopProgress = dialogue.subscribeProgress(run.id, (value) => {
					if (value.status === "running") speech!.append(value.text);
				});
			}
			const stop = () => stopProgress();
			controller.signal.addEventListener("abort", stop, { once: true });
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
			stopProgress();
			controller.signal.removeEventListener("abort", stop);
			if (!autoSpeak) {
				await store.write((db) =>
					larm.skipInTransaction?.(db, turn.utteranceId, "tts"),
				);
				await advance(turn.utteranceId, "completed");
				return;
			}
			if (!(await advance(turn.utteranceId, "synthesizing"))) return;
			speech!.append(answer, true);
			await speech!.work;
			if (controller.signal.aborted) return;
			if (speech!.error) throw speech!.error;
			await advance(turn.utteranceId, speech!.chunks.size ? "ready" : "played");
			if (!speech!.chunks.size) audio.delete(turn.utteranceId);
		} catch (error) {
			audio.delete(turn.utteranceId);
			if (!controller.signal.aborted)
				await advance(turn.utteranceId, "failed", {
					error: error instanceof Error ? error.message : "voice_failed",
				}).catch(() => {});
		} finally {
			stopProgress();
			controller.abort();
			if (controller.signal.aborted) audio.get(turn.utteranceId)?.wake();
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
			if (fresh) {
				previews.get(utteranceId)?.controller.abort();
				const controller = new AbortController();
				controllers.set(utteranceId, controller);
				void process(turn, wav, controller);
			}
			return turn;
		},

		async preview(
			sessionId: string,
			generation: number,
			id: string,
			wav: Uint8Array,
		) {
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
				audioComplete: state?.finished ?? false,
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
			const state = audio.get(id);
			if (!state?.chunks.has(index)) return this.get(id);
			await store.write((db) => {
				const current = get(db, id);
				if (
					!current ||
					!["responding", "synthesizing", "ready"].includes(current.status)
				)
					return;
				state.chunks.delete(index);
				state.wake();
				update(
					db,
					id,
					current.revision,
					state.finished && !state.chunks.size ? "played" : current.status,
					clock(),
				);
			});
			if (state.finished && !state.chunks.size) audio.delete(id);
			return this.get(id);
		},
		async cancel(id: string) {
			previews.get(id)?.controller.abort();
			const turn = store.read((db) => get(db, id));
			if (!turn) return null;
			await advance(id, "cancelled", { error: "cancel_requested" });
			controllers.get(id)?.abort();
			previews.get(id)?.controller.abort();
			audio.get(id)?.wake();
			await larm.cancelSubject?.(id);
			audio.delete(id);
			if (turn.runId) await dialogue.cancel(turn.runId);
			return this.get(id);
		},
		async stop(sessionId: string, generation: number) {
			if (sessions.get(sessionId) !== generation) return;
			sessions.delete(sessionId);
			warming.get(sessionId)?.abort();
			for (const p of previews.values())
				if (p.sessionId === sessionId) p.controller.abort();
			const ids = store.read((db) => activeIds(db, sessionId, generation));
			await Promise.all(ids.map((id) => this.cancel(id)));
		},
		async close() {
			for (const c of controllers.values()) c.abort();
			controllers.clear();
			for (const p of previews.values()) p.controller.abort();
			previews.clear();
			for (const c of warming.values()) c.abort();
			warming.clear();
			for (const a of audio.values()) a.wake();
			sessions.clear();
			audio.clear();
		},
	};
}
export type VoiceDialogueService = ReturnType<typeof createVoiceDialogue>;
