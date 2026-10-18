import type { Viewing } from "../../dialogue/contracts";
import { measureStage } from "../../../infrastructure/performance";
import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { InferencePort } from "../../inference";
import type { VoiceTurn } from "../contracts";
import { get, lastSequence, update } from "../repository";
import {
	previousInputId,
	readInput,
	saveInput,
	type PreparedInput,
} from "../repository/input";
import type { createVoiceResponder } from "./respond";
import { createLanguageFilter } from "./language-filter";
import { toErrorCode } from "../../../infrastructure/error-code";
import { getLogger, withLogContext } from "../../../infrastructure/logger";
const log = getLogger("voice-dialogue");
/** The dialogue input limit: a merged input must still be accepted when sent. */
const MAX_TEXT = 8000;

/**
 * Serializes recognition per session, while answering stays on the existing dialogue queue.
 * A transcript in an allowed language is ready as heard; one in any other language is noise.
 * A segment arriving before the previous one was committed (the speaker resumed after a
 * pause) continues that input.
 */
export function createInputCollector({
	store,
	larm,
	sessions,
	controllers,
	respond,
	clock,
}: {
	store: SqliteStore;
	larm: InferencePort;
	sessions: Map<string, number>;
	controllers: Map<string, AbortController>;
	respond: ReturnType<typeof createVoiceResponder>;
	clock: () => string;
}) {
	const tails = new Map<string, Promise<void>>();
	const allowedLanguage = createLanguageFilter({ store, larm });
	const valid = (turn: VoiceTurn, signal: AbortSignal) => {
		signal.throwIfAborted();
		if (sessions.get(turn.sessionId) !== turn.generation)
			throw new Error("voice_input_stale");
	};
	async function transcribe(
		turn: VoiceTurn,
		wav: Uint8Array,
		signal: AbortSignal,
	) {
		const asrId = store.read((db) =>
			larm.requestFor?.(db, turn.utteranceId, "asr"),
		);
		if (!asrId || !larm.executeRequest) throw new Error("permission_revoked");
		return measureStage(
			"voice-dialogue",
			"asr",
			() => larm.executeRequest!(asrId, wav, signal),
			{ utteranceId: turn.utteranceId },
		);
	}
	/**
	 * Makes this turn the session's pending input: the previous uncommitted input (if any)
	 * followed by what was heard. Without either, the turn ends as empty.
	 */
	function stage(
		db: Database,
		turn: VoiceTurn,
		current: VoiceTurn,
		heard: { text: string; requestId: string } | null,
	) {
		const previousId = previousInputId(
			db,
			turn.sessionId,
			turn.generation,
			turn.sequence,
		);
		const previous = previousId ? get(db, previousId) : null;
		const previousPrepared = previousId ? readInput(db, previousId) : null;
		const addition = heard?.text.trim() ?? "";
		if (!addition && !previous) {
			update(db, turn.utteranceId, current.revision, "completed", clock(), {
				text: "",
			});
			larm.skipInTransaction?.(db, turn.utteranceId, "llm");
			larm.skipInTransaction?.(db, turn.utteranceId, "tts");
			return "completed" as const;
		}
		// Noise (or another language) after a pause carries the pending input forward instead of stranding it
		// behind a later sequence. (A failed segment cannot: its own ASR was never accepted.)
		const prepared: PreparedInput = {
			utteranceId: turn.utteranceId,
			sources: [...(previousPrepared?.sources ?? []), turn.utteranceId],
			asrRequests: [
				...(previousPrepared?.asrRequests ?? []),
				...(heard ? [heard.requestId] : []),
			],
		};
		const text = [previous?.text, addition].filter(Boolean).join("\n");
		if (prepared.sources.length > 32 || text.length > MAX_TEXT)
			throw new Error("voice_input_capacity");
		if (previous) {
			if (
				!update(db, previous.utteranceId, previous.revision, "merged", clock())
			)
				throw new Error("voice_input_stale");
			larm.skipInTransaction?.(db, previous.utteranceId, "llm");
			larm.skipInTransaction?.(db, previous.utteranceId, "tts");
		}
		saveInput(db, prepared);
		if (
			!update(db, turn.utteranceId, current.revision, "input_ready", clock(), {
				text,
			})
		)
			throw new Error("voice_input_stale");
		return previous ? ("merged" as const) : ("input_ready" as const);
	}
	async function collect(
		turn: VoiceTurn,
		wav: Uint8Array,
		controller: AbortController,
	) {
		try {
			valid(turn, controller.signal);
			const receipt = await transcribe(turn, wav, controller.signal);
			const heard = receipt.value as string;
			const adopted =
				!heard.trim() ||
				(await allowedLanguage(turn, heard, controller.signal));
			valid(turn, controller.signal);
			const status = await store.write((db) => {
				valid(turn, controller.signal);
				const current = get(db, turn.utteranceId);
				if (
					current?.status !== "recognizing" ||
					!larm.acceptInTransaction?.(db, receipt)
				)
					throw new Error("permission_revoked");
				return stage(db, turn, current, {
					text: adopted ? heard : "",
					requestId: receipt.requestId,
				});
			});
			const reason = adopted ? "empty_transcript" : "language_not_allowed";
			if (status === "completed") log.info("voice.input_ignored", { reason });
			else
				log.info("voice.input_prepared", {
					utteranceId: turn.utteranceId,
					sessionId: turn.sessionId,
					generation: turn.generation,
					status,
					...(adopted ? {} : { reason }),
				});
		} catch (error) {
			if (!controller.signal.aborted) {
				const reason = toErrorCode(error, "voice_failed");
				log.warn("voice.input_preparation_failed", {
					utteranceId: turn.utteranceId,
					reason,
				});
				await store
					.write((db) => {
						const current = get(db, turn.utteranceId);
						if (current?.status !== "recognizing") return;
						update(db, turn.utteranceId, current.revision, "failed", clock(), {
							error: reason,
						});
					})
					.catch(() => {});
			}
		} finally {
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
		async commit(id: string, revision: number, viewing?: Viewing) {
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
				if (turn.status !== "input_ready")
					throw new Error("voice_input_not_ready");
				for (const requestId of prepared.asrRequests)
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
							prepared.asrRequests,
							controller,
							viewing,
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
