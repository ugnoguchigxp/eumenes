import type { RunViewing } from "../../dialogue/contracts";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { Database } from "bun:sqlite";
import type { DialogueService } from "../../dialogue";
import type { InferencePort } from "../../inference";
import type { SpeechPreparation } from "../../delivery";
import type { VoiceTurn } from "../contracts";
import type { Speech } from "./speech-state";
import { spokenPrefix, spokenText } from "./spoken-text";
import { getLogger } from "../../../infrastructure/logger";
const log = getLogger("voice-dialogue");
export type VoiceAdvance = (
	id: string,
	status: VoiceTurn["status"],
) => Promise<boolean>;
/**
 * How long a played turn waits at most for its run to end before it records what was heard: one still running then
 * keeps its own words (a hand-over's work answers with its report).
 */
const UNADOPTED_WAIT_MS = 180_000;
/** Waits for the run to end (up to its deadline), then records what was heard of it if it kept no answer. */
async function recordUnadopted(
	store: SqliteStore,
	dialogue: DialogueService,
	runId: string,
	deadlineAt: string | null | undefined,
	heard: string,
) {
	try {
		await dialogue.waitForTerminal(runId, {
			timeoutMs: Math.min(
				UNADOPTED_WAIT_MS,
				deadlineAt
					? Math.max(0, Date.parse(deadlineAt) - Date.now()) + 10_000
					: UNADOPTED_WAIT_MS,
			),
		});
		await store.write((db) =>
			dialogue.recordUnadoptedSpeechInTransaction(db, runId, heard),
		);
	} catch {
		// The store closed or the wait ended: the run's own record stands.
	}
}
export function createVoiceResponder({
	store,
	dialogue,
	larm,
	advance,
	createSpeech,
	audio,
	linkRunInTransaction,
}: {
	store: SqliteStore;
	dialogue: DialogueService;
	larm: InferencePort;
	advance: VoiceAdvance;
	createSpeech: (
		id: string,
		runId: string,
		controller: AbortController,
		preparation: SpeechPreparation,
	) => Speech;
	audio: Map<string, Speech>;
	linkRunInTransaction: (db: Database, id: string, runId: string) => void;
}) {
	return async (
		turn: VoiceTurn,
		text: string,
		transcriptionRequestIds: string[],
		controller: AbortController,
		viewing?: RunViewing,
	) => {
		controller.signal.throwIfAborted();
		if (!transcriptionRequestIds.every((id) => larm.validRequest?.(id)))
			throw new Error("permission_revoked");
		let run: Awaited<ReturnType<DialogueService["submitVoice"]>>;
		try {
			run = await dialogue.submitVoice(
				{
					requestId: turn.utteranceId,
					utteranceId: turn.utteranceId,
					conversationId: "main",
					text,
					...(viewing ? { viewing } : {}),
				},
				turn.utteranceId,
				transcriptionRequestIds,
				(db, accepted) =>
					linkRunInTransaction(db, turn.utteranceId, accepted.id),
			);
		} catch (error) {
			// Cancelled meanwhile: the run was rolled back with the link.
			if (error instanceof Error && error.message === "voice_turn_inactive")
				return;
			throw error;
		}

		const snapshot = store.read((db) =>
			larm.snapshotFor?.(db, turn.utteranceId),
		);
		const autoSpeak = !snapshot || snapshot.voice.autoSpeak;
		const speechController = new AbortController();
		const stopSpeech = () => speechController.abort(controller.signal.reason);
		controller.signal.addEventListener("abort", stopSpeech, { once: true });
		let speech: Speech | undefined;
		let preparation: SpeechPreparation | undefined;
		let unsubscribe = () => {};
		let unsubscribeBody = () => {};
		let detachBody = () => {};
		let generationId: string | undefined;
		let streamError: unknown;
		let sourcePrefix = "";
		let bodyPrefix = "";
		let announcement = "";
		const append = (body: string, final = false) => {
			if (!body.startsWith(bodyPrefix))
				throw new Error("speech_stream_diverged");
			sourcePrefix += body.slice(bodyPrefix.length);
			bodyPrefix = body;
			speech!.append(spokenPrefix(sourcePrefix, final), final);
		};
		try {
			if (autoSpeak) {
				await store.write((db) =>
					larm.skipInTransaction?.(db, turn.utteranceId, "tts"),
				);
				controller.signal.throwIfAborted();
				preparation = {
					deliveryScope: "chunk",
					collection: {
						conversationId: run.conversationId,
						turnId: run.id,
						granularity: "chunk",
						chunkOrder: null,
					},
					context: dialogue.answerContext?.(run.id) ?? {
						answer: "",
						turns: [],
					},
				};
				speech = createSpeech(
					turn.utteranceId,
					run.id,
					speechController,
					preparation,
				);
				log.info("voice.synthesis_started", { runId: run.id });
				unsubscribeBody = dialogue.subscribeAnswerStream(run.id, (body) => {
					if (controller.signal.aborted || speechController.signal.aborted)
						return;
					try {
						if (generationId !== body.generationId) {
							detachBody();
							generationId = body.generationId;
							// Freeze the prepared input's conversation once for this generation.
							preparation!.context =
								dialogue.answerContext(run.id) ?? preparation!.context;
							const revoke = () => {
								streamError =
									body.signal.reason ?? new Error("generation_cancelled");
								speechController.abort(streamError);
								audio.delete(turn.utteranceId);
							};
							body.signal.addEventListener("abort", revoke, { once: true });
							detachBody = () =>
								body.signal.removeEventListener("abort", revoke);
							if (body.signal.aborted) return revoke();
						}
						preparation!.context = {
							...preparation!.context!,
							answer: spokenText(body.text),
						};
						append(body.text);
					} catch (error) {
						streamError = error;
						speechController.abort(error);
						audio.delete(turn.utteranceId);
					}
				});
				unsubscribe =
					dialogue.subscribeProgress?.(run.id, (progress) => {
						if (controller.signal.aborted || speechController.signal.aborted)
							return;
						if (
							["failed", "cancelled", "interrupted"].includes(progress.status)
						) {
							speechController.abort();
							audio.delete(turn.utteranceId);
							return;
						}
						const newNotice =
							!!progress.announcement && progress.announcement !== announcement;
						if (progress.status !== "running" && progress.status !== "queued")
							return;
						if (!newNotice) return;
						announcement = progress.announcement!;
						try {
							// A tool notice may follow a preamble that was already streamed.
							sourcePrefix += `${sourcePrefix ? "\n" : ""}${announcement}\n`;
							preparation!.context = {
								...(dialogue.answerContext?.(run.id) ?? preparation!.context!),
								answer: spokenText(sourcePrefix),
							};
							speech!.append(spokenPrefix(sourcePrefix, true), false, true);
						} catch (error) {
							streamError = error;
							speechController.abort();
						}
					}) ?? (() => {});
			}
			const waitFor = (deadlineAt: string | null | undefined) =>
				deadlineAt
					? Math.max(0, Date.parse(deadlineAt) - Date.now()) + 10_000
					: undefined;
			let final = await dialogue.waitForTerminal(run.id, {
				signal: AbortSignal.any([controller.signal, speechController.signal]),
				timeoutMs: waitFor(run.deadlineAt),
			});
			// A toolchain with its own run time moved the deadline later meanwhile: keep waiting until that one.
			while (
				!controller.signal.aborted &&
				!speechController.signal.aborted &&
				final &&
				["queued", "running"].includes(final.status) &&
				final.deadlineAt &&
				Date.parse(final.deadlineAt) + 10_000 > Date.now()
			)
				final = await dialogue.waitForTerminal(run.id, {
					signal: AbortSignal.any([controller.signal, speechController.signal]),
					timeoutMs: waitFor(final.deadlineAt),
				});
			if (controller.signal.aborted) return;
			if (streamError) throw streamError;
			if (final && ["queued", "running"].includes(final.status)) {
				await dialogue.stopReply(run.id);
				throw new Error("dialogue_wait_timeout");
			}
			if (final?.status !== "completed")
				throw new Error(final?.error ?? "dialogue_incomplete");
			// The generation chose not to speak (ContextWindow section 2): the turn ends quietly, not as a failure.
			if (!final.answerMessageId) {
				speechController.abort();
				audio.delete(turn.utteranceId);
				log.info("voice.synthesis_skipped", {
					runId: run.id,
					reason: "no_answer",
				});
				if (!speech)
					await store.write((db) =>
						larm.skipInTransaction?.(db, turn.utteranceId, "tts"),
					);
				await advance(turn.utteranceId, speech ? "played" : "completed");
				return;
			}
			const answer = dialogue.answerText(run.id);
			if (!answer) throw new Error("answer_missing");
			if (!speech) {
				log.info("voice.synthesis_skipped", {
					runId: run.id,
					reason: "auto_speak_disabled",
				});
				await store.write((db) =>
					larm.skipInTransaction?.(db, turn.utteranceId, "tts"),
				);
				await advance(turn.utteranceId, "completed");
				return;
			}
			if (!(await advance(turn.utteranceId, "synthesizing"))) return;
			preparation!.context = dialogue.answerContext?.(run.id) ?? {
				answer,
				turns: preparation!.context?.turns ?? [],
			};
			announcement = final.announcement ?? announcement;
			// Work that runs on its own answers with its announcement, which was already spoken.
			append(answer === announcement ? bodyPrefix : answer, true);
			await speech.work;
			if (controller.signal.aborted) return;
			if (speech.error) throw speech.error;
			log.info("voice.synthesis_completed", {
				runId: run.id,
				count: speech.chunks.size,
			});
			if (speech.skipped > 0)
				log.warn("voice.speech_truncated", {
					runId: run.id,
					count: speech.skipped,
				});
			// All streamed clauses may have played before adoption created the answer's receipt.
			if (!speech.chunks.size && speech.played.length)
				await store.write((db) =>
					dialogue.recordHeardInTransaction(
						db,
						run.id,
						speech!.skipped > 0 ? "partial" : "full",
						speech!.played.map((part) => part.text).join(""),
					),
				);
			await advance(turn.utteranceId, speech.chunks.size ? "ready" : "played");
			if (!speech.chunks.size) audio.delete(turn.utteranceId);
		} catch (error) {
			speechController.abort();
			// An adopted answer whose speech failed reached the user only as far as it was played.
			const played = speech?.played ?? [];
			await store
				.write((db) =>
					dialogue.recordHeardInTransaction(
						db,
						run.id,
						played.length ? "partial" : "none",
						played.map((part) => part.text).join(""),
					),
				)
				.catch(() => undefined);
			audio.delete(turn.utteranceId);
			throw error;
		} finally {
			unsubscribe();
			unsubscribeBody();
			detachBody();
			controller.signal.removeEventListener("abort", stopSpeech);
			if (controller.signal.aborted) {
				speechController.abort();
				audio.delete(turn.utteranceId);
			}
			// What was played of a run that keeps no answer is what the user heard: the chat and the record keep it once
			// the run has ended (a stop ends it just after this turn lets go; one still answering keeps its own words).
			const heard = (speech?.played ?? []).map((part) => part.text).join("");
			if (heard)
				void recordUnadopted(store, dialogue, run.id, run.deadlineAt, heard);
		}
	};
}
