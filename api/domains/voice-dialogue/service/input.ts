import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { DialogueService } from "../../dialogue";
import type { InferencePort } from "../../inference";
import type { VoiceTurn } from "../contracts";
import { get, lastSequence, update } from "../repository";
import {
	previousInputId,
	readInput,
	saveInput,
	type PreparedInput,
} from "../repository/input";
import { recognizeInput } from "./recognize";
import type { createVoiceResponder } from "./respond";
import { toErrorCode } from "../../../infrastructure/error-code";
import { getLogger, withLogContext } from "../../../infrastructure/logger";
const log = getLogger("voice-dialogue");
const CONFIDENCE = 0.8;

/** Serializes recognition per session, while answering stays on the existing dialogue queue. */
export function createInputCollector({
	store,
	dialogue,
	larm,
	sessions,
	languageRequests,
	controllers,
	respond,
	clock,
}: {
	store: SqliteStore;
	dialogue: DialogueService;
	larm: InferencePort;
	sessions: Map<string, number>;
	languageRequests: Map<string, string>;
	controllers: Map<string, AbortController>;
	respond: ReturnType<typeof createVoiceResponder>;
	clock: () => string;
}) {
	const tails = new Map<string, Promise<void>>();
	const valid = (turn: VoiceTurn, signal: AbortSignal) => {
		signal.throwIfAborted();
		if (sessions.get(turn.sessionId) !== turn.generation)
			throw new Error("voice_input_stale");
	};
	async function collect(
		turn: VoiceTurn,
		wav: Uint8Array,
		controller: AbortController,
	) {
		let prepared: PreparedInput | undefined;
		let previous: VoiceTurn | null = null;
		let previousPrepared: PreparedInput | null = null;
		try {
			valid(turn, controller.signal);
			const previousId = store.read((db) =>
				previousInputId(db, turn.sessionId, turn.generation, turn.sequence),
			);
			previous = previousId ? store.read((db) => get(db, previousId)) : null;
			previousPrepared = previousId
				? store.read((db) => readInput(db, previousId))
				: null;
			const last = dialogue
				.list("main")
				.reverse()
				.find((r) => r.status === "completed");
			const context = last ? dialogue.answerContext(last.id) : null;
			const conversation = context
				? [...context.turns, { role: "assistant", text: context.answer }]
						.slice(-4)
						.map((t) => ({ role: t.role, text: t.text.slice(0, 2000) }))
				: [];
			const result = await recognizeInput({
				store,
				larm,
				turn,
				wav,
				controller,
				languageRequests,
				context: () => ({ previousText: previous?.text ?? "", conversation }),
				onTranscript: async (text, receipt) => {
					prepared = {
						utteranceId: turn.utteranceId,
						rawText: text,
						sources: [turn.utteranceId],
						asrRequests: [receipt.requestId],
						languageRequest: null,
						readiness: "uncertain",
					};
					await store.write((db) => {
						valid(turn, controller.signal);
						const current = get(db, turn.utteranceId);
						if (
							current?.status !== "recognizing" ||
							!larm.acceptInTransaction?.(db, receipt)
						)
							throw new Error("permission_revoked");
						saveInput(db, prepared!);
						if (
							!update(
								db,
								turn.utteranceId,
								current.revision,
								"recognizing",
								clock(),
								{ text },
							)
						)
							throw new Error("voice_input_stale");
					});
				},
			});
			valid(turn, controller.signal);
			if (!prepared) throw new Error("asr_language_unverified");
			if (!result.text.trim()) {
				await store.write((db) => {
					const current = get(db, turn.utteranceId);
					valid(turn, controller.signal);
					if (current)
						update(
							db,
							turn.utteranceId,
							current.revision,
							"completed",
							clock(),
						);
					larm.skipInTransaction?.(db, turn.utteranceId, "llm");
					larm.skipInTransaction?.(db, turn.utteranceId, "tts");
				});
				return;
			}
			const a = result.assessment!;
			const related =
				a.relation === "continuation" && a.relationConfidence >= CONFIDENCE;
			const uncertain =
				a.relation === "uncertain" || a.relationConfidence < CONFIDENCE;
			const text =
				related && previous?.text
					? previous.text + "\n" + result.text
					: result.text;
			if (related && previousPrepared) {
				prepared.sources = [...previousPrepared.sources, turn.utteranceId];
				prepared.asrRequests = [
					...previousPrepared.asrRequests,
					...prepared.asrRequests,
				];
			}
			if (prepared.sources.length > 32 || text.length > 8192)
				throw new Error("voice_input_capacity");
			prepared.languageRequest = result.languageId!;
			prepared.readiness =
				!uncertain && a.readinessConfidence >= CONFIDENCE
					? a.readiness
					: "uncertain";
			const status =
				prepared.readiness === "ready"
					? "input_ready"
					: prepared.readiness === "waiting"
						? "awaiting_input"
						: "draft";
			await store.write((db) => {
				valid(turn, controller.signal);
				const current = get(db, turn.utteranceId);
				if (
					current?.status !== "recognizing" ||
					!larm.acceptInTransaction?.(db, result.languageReceipt!)
				)
					throw new Error("permission_revoked");
				if (previous && !uncertain) {
					const prior = get(db, previous.utteranceId);
					if (
						!prior ||
						prior.revision !== previous.revision ||
						!["awaiting_input", "input_ready", "draft"].includes(prior.status)
					)
						throw new Error("voice_input_stale");
					if (
						!update(
							db,
							prior.utteranceId,
							prior.revision,
							related ? "merged" : "draft",
							clock(),
						)
					)
						throw new Error("voice_input_stale");
					if (related) {
						larm.skipInTransaction?.(db, previous.utteranceId, "llm");
						larm.skipInTransaction?.(db, previous.utteranceId, "tts");
					}
				}
				saveInput(db, prepared!);
				if (
					!update(db, turn.utteranceId, current.revision, status, clock(), {
						text,
					})
				)
					throw new Error("voice_input_stale");
			});
			log.info("voice.input_prepared", {
				utteranceId: turn.utteranceId,
				sessionId: turn.sessionId,
				generation: turn.generation,
				status,
				count: prepared.sources.length,
			});
		} catch (error) {
			if (!controller.signal.aborted) {
				log.warn("voice.input_preparation_failed", {
					utteranceId: turn.utteranceId,
					reason: toErrorCode(error, "asr_language_unverified"),
				});
				await store
					.write((db) => {
						const current = get(db, turn.utteranceId);
						if (current && current.status === "recognizing")
							update(db, turn.utteranceId, current.revision, "draft", clock(), {
								error: toErrorCode(error, "asr_language_unverified"),
							});
					})
					.catch(() => {});
			}
		} finally {
			const languageId = languageRequests.get(turn.utteranceId);
			languageRequests.delete(turn.utteranceId);
			if (languageId) {
				await store
					.write((db) => larm.cancelRequestsInTransaction?.(db, [languageId]))
					.catch(() => {});
				larm.flushCancelledRequests?.([languageId]);
			}
			if (controllers.get(turn.utteranceId) === controller)
				controllers.delete(turn.utteranceId);
			controller.abort();
		}
	}
	return {
		accept(turn: VoiceTurn, wav: Uint8Array, controller: AbortController) {
			const key = `${turn.sessionId}:${turn.generation}`;
			const tail = (tails.get(key) ?? Promise.resolve()).then(() =>
				collect(turn, wav, controller),
			);
			tails.set(key, tail);
			void tail.finally(() => {
				if (tails.get(key) === tail) tails.delete(key);
			});
		},
		async commit(id: string, revision: number) {
			const controller = new AbortController();
			const { turn, prepared } = await store.write((db) => {
				const turn = get(db, id),
					prepared = readInput(db, id);
				if (!turn || !prepared) throw new Error("voice_input_not_ready");
				valid(turn, controller.signal);
				// An exact duplicate commit is harmless, even if answering is already underway.
				if (turn.runId || turn.status === "responding")
					return { turn, prepared: null };
				if (
					turn.sequence !== lastSequence(db, turn.sessionId, turn.generation) ||
					turn.revision !== revision
				)
					throw new Error("voice_input_stale");
				if (
					turn.status !== "input_ready" ||
					prepared.readiness !== "ready" ||
					!prepared.languageRequest
				)
					throw new Error("voice_input_not_ready");
				for (const requestId of [
					...prepared.asrRequests,
					prepared.languageRequest,
				])
					if (!larm.validInTransaction?.(db, requestId))
						throw new Error("permission_revoked");
				if (!update(db, id, revision, "responding", clock()))
					throw new Error("voice_input_stale");
				return { turn: get(db, id)!, prepared };
			});
			if (prepared) {
				controllers.set(id, controller);
				void withLogContext(
					{
						utteranceId: id,
						sessionId: turn.sessionId,
						generation: turn.generation,
					},
					() =>
						respond(
							turn,
							turn.text!,
							prepared.asrRequests.at(-1)!,
							prepared.languageRequest!,
							controller,
							prepared.asrRequests,
						),
				)
					.catch(async (error) => {
						if (controller.signal.aborted) return;
						log.warn("voice.input_response_failed", {
							reason: toErrorCode(error, "voice_failed"),
						});
						await store.write((db) => {
							const current = get(db, id);
							if (current)
								update(db, id, current.revision, "failed", clock(), {
									error: toErrorCode(error, "voice_failed"),
								});
						});
					})
					.finally(() => {
						controller.abort();
						if (controllers.get(id) === controller) controllers.delete(id);
					});
			}
			return turn;
		},
	};
}
