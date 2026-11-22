import type { RunViewing } from "../../dialogue/contracts";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { Database } from "bun:sqlite";
import type { DialogueService } from "../../dialogue";
import type { InferencePort } from "../../inference";
import type { SpeechPreparation } from "../../delivery";
import type { VoiceTurn } from "../contracts";
import type { Speech } from "./speech-state";
import { reconcileSpeechBody, spokenPrefix, spokenText } from "./spoken-text";
import { getLogger } from "../../../infrastructure/logger";
import { get, update } from "../repository";
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
type SpokenBindings = {
	speech: Speech | undefined;
	speechController: AbortController;
	generationId: string | undefined;
	sourcePrefix: string;
	bodyPrefix: string;
	detachBody: () => void;
	announcement: string;
};

/**
 * Follows one run's answer text and tool notices into the speech already started for that turn.
 * Recording what was heard stays with the caller, after the run ends or the speech fails.
 */
function watchSpokenAnswer({
	bindings,
	dialogue,
	run,
	controller,
	speechFailure,
	preparation,
	previousSpeech,
	sequence,
	startSpeech,
	store,
	utteranceId,
	clock,
	failSpeech,
	audio,
	append,
}: {
	bindings: SpokenBindings;
	dialogue: DialogueService;
	run: { id: string };
	controller: AbortController;
	speechFailure: AbortController;
	preparation: SpeechPreparation;
	previousSpeech: Speech[];
	sequence: { generation: number; nextIndex: number };
	startSpeech: () => Speech;
	store: SqliteStore;
	utteranceId: string;
	clock: () => string;
	failSpeech: (error: unknown) => void;
	audio: Map<string, Speech>;
	append: (body: string, final?: boolean) => void;
}) {
	const unsubscribeBody = dialogue.subscribeAnswerStream(run.id, (body) => {
		if (controller.signal.aborted || speechFailure.signal.aborted) return;
		try {
			if (bindings.generationId !== body.generationId) {
				bindings.detachBody();
				const replacing = bindings.generationId !== undefined;
				bindings.generationId = body.generationId;
				if (replacing) {
					previousSpeech.push(bindings.speech!);
					bindings.speech = undefined;
				}
				// Freeze the prepared input's conversation once for this generation.
				preparation.context =
					dialogue.answerContext(run.id) ?? preparation.context;
				if (replacing) {
					bindings.speechController = new AbortController();
					sequence.generation++;
					bindings.bodyPrefix = "";
					bindings.sourcePrefix = "";
					bindings.speech = startSpeech();
					// Notify the browser even if the new generation takes time to speak.
					const scoped = bindings.speechController.signal;
					void store
						.write((db) => {
							const current = get(db, utteranceId);
							if (!scoped.aborted && current?.status === "responding")
								update(
									db,
									utteranceId,
									current.revision,
									current.status,
									clock(),
								);
						})
						.catch((error) => {
							if (!scoped.aborted) failSpeech(error);
						});
				}
				const revoke = () => {
					const reason =
						body.signal.reason ?? new Error("generation_cancelled");
					if (
						reason instanceof Error &&
						reason.message === "generation_replaced"
					) {
						// The next body is published synchronously by AnswerStreams.open.
						bindings.speechController.abort(reason);
						audio.delete(utteranceId);
					} else failSpeech(reason);
				};
				body.signal.addEventListener("abort", revoke, { once: true });
				bindings.detachBody = () =>
					body.signal.removeEventListener("abort", revoke);
				if (body.signal.aborted) return revoke();
			}
			preparation.context = {
				...preparation.context!,
				answer: spokenText(body.text),
			};
			append(body.text);
		} catch (error) {
			failSpeech(error);
		}
	});
	const unsubscribe =
		dialogue.subscribeProgress?.(run.id, (progress) => {
			if (controller.signal.aborted || bindings.speechController.signal.aborted)
				return;
			if (["failed", "cancelled", "interrupted"].includes(progress.status)) {
				bindings.speechController.abort();
				audio.delete(utteranceId);
				return;
			}
			const newNotice =
				!!progress.announcement &&
				progress.announcement !== bindings.announcement;
			if (progress.status !== "running" && progress.status !== "queued") return;
			if (!newNotice) return;
			bindings.announcement = progress.announcement!;
			try {
				// A tool notice may follow a preamble that was already streamed.
				bindings.sourcePrefix += `${bindings.sourcePrefix ? "\n" : ""}${bindings.announcement}\n`;
				preparation.context = {
					...(dialogue.answerContext?.(run.id) ?? preparation.context!),
					answer: spokenText(bindings.sourcePrefix),
				};
				bindings.speech!.append(
					spokenPrefix(bindings.sourcePrefix, true),
					false,
					true,
				);
			} catch (error) {
				failSpeech(error);
			}
		}) ?? (() => {});
	return { unsubscribeBody, unsubscribe };
}

export function createVoiceResponder({
	store,
	dialogue,
	larm,
	advance,
	createSpeech,
	audio,
	linkRunInTransaction,
	clock,
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
		sequence: { generation: number; nextIndex: number },
	) => Speech;
	audio: Map<string, Speech>;
	linkRunInTransaction: (db: Database, id: string, runId: string) => void;
	clock: () => string;
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
		const live: SpokenBindings = {
			speech: undefined,
			speechController: new AbortController(),
			generationId: undefined,
			sourcePrefix: "",
			bodyPrefix: "",
			detachBody: () => {},
			announcement: "",
		};
		const speechFailure = new AbortController();
		const sequence = { generation: 0, nextIndex: 0 };
		const previousSpeech: Speech[] = [];
		const stopSpeech = () =>
			live.speechController.abort(controller.signal.reason);
		controller.signal.addEventListener("abort", stopSpeech, { once: true });
		let preparation: SpeechPreparation | undefined;
		let unsubscribe = () => {};
		let unsubscribeBody = () => {};
		const failSpeech = (error: unknown) => {
			speechFailure.abort(error);
			live.speechController.abort(error);
			audio.delete(turn.utteranceId);
		};
		const startSpeech = () =>
			createSpeech(
				turn.utteranceId,
				run.id,
				live.speechController,
				preparation!,
				sequence,
			);
		const append = (body: string, final = false) => {
			body = reconcileSpeechBody(body, live.bodyPrefix, final);
			live.sourcePrefix += body.slice(live.bodyPrefix.length);
			live.bodyPrefix = body;
			live.speech!.append(spokenPrefix(live.sourcePrefix, final), final);
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
				live.speech = startSpeech();
				log.info("voice.synthesis_started", { runId: run.id });
				({ unsubscribeBody, unsubscribe } = watchSpokenAnswer({
					bindings: live,
					dialogue,
					run,
					controller,
					speechFailure,
					preparation: preparation!,
					previousSpeech,
					sequence,
					startSpeech,
					store,
					utteranceId: turn.utteranceId,
					clock,
					failSpeech,
					audio,
					append,
				}));
			}
			const waitFor = (deadlineAt: string | null | undefined) =>
				deadlineAt
					? Math.max(0, Date.parse(deadlineAt) - Date.now()) + 10_000
					: undefined;
			const responseSignal = AbortSignal.any([
				controller.signal,
				speechFailure.signal,
			]);
			let final = await dialogue.waitForTerminal(run.id, {
				signal: responseSignal,
				timeoutMs: waitFor(run.deadlineAt),
			});
			// A toolchain with its own run time moved the deadline later meanwhile: keep waiting until that one.
			while (
				!responseSignal.aborted &&
				final &&
				["queued", "running"].includes(final.status) &&
				final.deadlineAt &&
				Date.parse(final.deadlineAt) + 10_000 > Date.now()
			)
				final = await dialogue.waitForTerminal(run.id, {
					signal: responseSignal,
					timeoutMs: waitFor(final.deadlineAt),
				});
			if (controller.signal.aborted) return;
			speechFailure.signal.throwIfAborted();
			if (final && ["queued", "running"].includes(final.status)) {
				await dialogue.stopReply(run.id);
				throw new Error("dialogue_wait_timeout");
			}
			if (final?.status !== "completed")
				throw new Error(final?.error ?? "dialogue_incomplete");
			// The generation chose not to speak (ContextWindow section 2): the turn ends quietly, not as a failure.
			if (!final.answerMessageId) {
				live.speechController.abort();
				audio.delete(turn.utteranceId);
				log.info("voice.synthesis_skipped", {
					runId: run.id,
					reason: "no_answer",
				});
				if (!live.speech)
					await store.write((db) =>
						larm.skipInTransaction?.(db, turn.utteranceId, "tts"),
					);
				await advance(turn.utteranceId, live.speech ? "played" : "completed");
				return;
			}
			const answer = dialogue.answerText(run.id);
			if (!answer) throw new Error("answer_missing");
			if (!live.speech) {
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
			live.announcement = final.announcement ?? live.announcement;
			// Work that runs on its own answers with its announcement, which was already spoken.
			append(answer === live.announcement ? live.bodyPrefix : answer, true);
			await live.speech.work;
			if (controller.signal.aborted) return;
			if (live.speech.error) throw live.speech.error;
			log.info("voice.synthesis_completed", {
				runId: run.id,
				count: live.speech.chunks.size,
			});
			if (live.speech.skipped > 0)
				log.warn("voice.speech_truncated", {
					runId: run.id,
					count: live.speech.skipped,
				});
			// All streamed clauses may have played before adoption created the answer's receipt.
			if (!live.speech.chunks.size && live.speech.played.length)
				await store.write((db) =>
					dialogue.recordHeardInTransaction(
						db,
						run.id,
						live.speech!.skipped > 0 ? "partial" : "full",
						live.speech!.played.map((part) => part.text).join(""),
					),
				);
			await advance(
				turn.utteranceId,
				live.speech.chunks.size ? "ready" : "played",
			);
			if (!live.speech.chunks.size) audio.delete(turn.utteranceId);
		} catch (error) {
			live.speechController.abort();
			// An adopted answer whose speech failed reached the user only as far as it was played.
			const played = live.speech?.played ?? [];
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
			live.detachBody();
			controller.signal.removeEventListener("abort", stopSpeech);
			if (controller.signal.aborted) {
				live.speechController.abort();
				audio.delete(turn.utteranceId);
			}
			// What was played of a run that keeps no answer is what the user heard: the chat and the record keep it once
			// the run has ended (a stop ends it just after this turn lets go; one still answering keeps its own words).
			const heard = [...previousSpeech, ...(live.speech ? [live.speech] : [])]
				.flatMap((part) => part.played)
				.map((part) => part.text)
				.join("");
			if (heard)
				void recordUnadopted(store, dialogue, run.id, run.deadlineAt, heard);
		}
	};
}
