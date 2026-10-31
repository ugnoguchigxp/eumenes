import type { Database } from "bun:sqlite";
import { canonicalJson, sha256Hex } from "../../../infrastructure/digest";
import {
	INTERACTION_POLICY,
	type InteractionAnswer,
	type InteractionAnswerResult,
} from "../contracts/command-interactions";
import type { Run } from "../contracts";
import {
	bodyBytes,
	eventByEventId,
	interactionById,
	interactionByQuestion,
} from "../repository/interactions";
import { DEFAULT_DEADLINE_MS, type Accept, type DialogueDeps } from "./context";
import type { InteractionCore } from "./interaction-core";

const canonical = (value: unknown) =>
	canonicalJson(value, { omitUndefined: true, keyOrder: "codeUnit" });

/**
 * Answers and cancellation: the UI endpoints and the natural-language answer. An answer is
 * accepted once, in the transaction that creates the run that resumes the operation.
 */
export function createInteractionAnswers(
	deps: DialogueDeps,
	core: InteractionCore,
	accept: (db: Database, input: Accept) => { run: Run; fresh: boolean },
) {
	const { store, queue, clock } = deps;
	const {
		nowMs,
		view,
		frozenValid,
		choiceFieldOf,
		addEvent,
		settle,
		expireDue,
	} = core;
	return {
		/**
		 * The conversation model answered an open question in natural language: the run that
		 * carries the utterance becomes the resumed run. Checks the target, the frozen refs and
		 * the schema; the writes happen only when all of them pass.
		 */
		acceptNaturalLanguageInTransaction(
			tx: Database,
			run: Run,
			chosen: {
				questionRef: string;
				functionName: string;
				revisionId: string;
				request: string;
			},
		): { ok: true; interactionId: string } | { ok: false; code: string } {
			const bound = deps.toolchains?.bound;
			if (!bound) return { ok: false, code: "adapter_unavailable" };
			const row = interactionByQuestion(tx, chosen.questionRef);
			if (
				!row ||
				row.conversationId !== run.conversationId ||
				row.functionName !== chosen.functionName ||
				row.status !== "waiting_input"
			)
				return { ok: false, code: "question_not_open" };
			if (expireDue(tx, row)) return { ok: false, code: "interaction_expired" };
			if (row.chainRevisionId !== chosen.revisionId || !frozenValid(tx, row)) {
				settle(tx, row, "cancelled", "version_invalidated");
				return { ok: false, code: "version_invalidated" };
			}
			const parsed = bound.parseAnswer("builtin:answerText", {
				text: chosen.request,
			});
			if (!parsed.ok) return { ok: false, code: "invalid_answer" };
			const changed = tx
				.query(
					`UPDATE command_interactions SET status='ready',revision=revision+1,
					 execution_generation=execution_generation+1,current_run_id=?,question_id=NULL,updated_at=?
					 WHERE id=? AND revision=? AND status='waiting_input'`,
				)
				.run(run.id, clock(), row.id, row.revision).changes;
			if (changed !== 1) return { ok: false, code: "question_not_open" };
			addEvent(tx, row.id, "answer", `nl:${run.id}`, {
				questionId: chosen.questionRef,
				value: parsed.value,
				runId: run.id,
			});
			if (bodyBytes(tx, row.id) > INTERACTION_POLICY.maxBodyBytes)
				throw new Error("interaction_body_too_large");
			return { ok: true, interactionId: row.id };
		},

		/**
		 * `POST /api/toolchain-interactions/:id/answers`. The answer is accepted once; the
		 * revision update, the new run and its COMMAND_KIND job commit together.
		 */
		async answer(
			interactionId: string,
			body: InteractionAnswer,
		): Promise<InteractionAnswerResult> {
			const inputDigest = sha256Hex(canonical(body.input ?? null));
			const result = await store.write(
				(
					tx,
				):
					| { ok: true; value: InteractionAnswerResult; fresh: boolean }
					| { ok: false; code: string } => {
					const bound = deps.toolchains?.bound;
					const seen = eventByEventId(tx, body.eventId);
					if (seen) {
						const payload = seen.payloadJson
							? (JSON.parse(seen.payloadJson) as Record<string, unknown>)
							: null;
						if (
							seen.kind !== "answer" ||
							seen.interactionId !== interactionId ||
							payload?.questionId !== body.questionId ||
							payload?.inputDigest !== inputDigest
						)
							return { ok: false, code: "request_conflict" };
						const row = interactionById(tx, interactionId)!;
						return {
							ok: true,
							fresh: false,
							value: {
								interaction: view(row),
								runId: String(payload.runId),
								replay: true,
							},
						};
					}
					const row = interactionById(tx, interactionId);
					if (!row) return { ok: false, code: "interaction_not_found" };
					if (row.status !== "waiting_input" || !row.questionId)
						return { ok: false, code: "interaction_closed" };
					if (expireDue(tx, row))
						return { ok: false, code: "interaction_expired" };
					if (row.revision !== body.expectedRevision)
						return { ok: false, code: "revision_conflict" };
					if (row.questionId !== body.questionId)
						return { ok: false, code: "question_stale" };
					if (!bound || !frozenValid(tx, row)) {
						settle(tx, row, "cancelled", "version_invalidated");
						return { ok: false, code: "version_invalidated" };
					}
					const parsed = bound.parseAnswer(
						row.questionSchemaRef ?? "builtin:answerText",
						body.input,
					);
					if (!parsed.ok) return { ok: false, code: "invalid_answer" };
					// A choice question accepts only a ref the host issued with it. The field comes
					// from the frozen binding, so it validates the same way after a restart.
					const field = row.questionChoicesJson
						? choiceFieldOf(tx, row)
						: undefined;
					if (row.questionChoicesJson && !field)
						return { ok: false, code: "version_invalidated" };
					if (field) {
						const chosen = (parsed.value as Record<string, unknown> | null)?.[
							field
						];
						const refs = (
							JSON.parse(row.questionChoicesJson!) as Array<{ ref: string }>
						).map((choice) => choice.ref);
						if (typeof chosen !== "string" || !refs.includes(chosen))
							return { ok: false, code: "invalid_answer" };
					}
					const now = nowMs();
					const deadlineMs = Math.max(
						1000,
						Math.min(DEFAULT_DEADLINE_MS, Date.parse(row.expiresAt) - now),
					);
					const { run, fresh } = accept(tx, {
						requestId: body.eventId,
						conversationId: row.conversationId,
						text: utterance(parsed.value),
						sourceKind: "manual",
						deadlineMs,
						resume: {
							interactionId: row.id,
							toolchainRevisionId: row.chainRevisionId,
						},
					});
					// The run id is the answer's event id; an existing run under it is not this answer's.
					if (!fresh) return { ok: false, code: "request_conflict" };
					const changed = tx
						.query(
							`UPDATE command_interactions SET status='ready',revision=revision+1,
							 execution_generation=execution_generation+1,current_run_id=?,question_id=NULL,updated_at=?
							 WHERE id=? AND revision=? AND status='waiting_input'`,
						)
						.run(run.id, clock(), row.id, row.revision).changes;
					if (changed !== 1) return { ok: false, code: "interaction_closed" };
					// The TODO that asked waits with the answering run now: its result reports there.
					for (const work of deps.work?.waitingOfRunInTransaction(
						tx,
						row.currentRunId,
					) ?? [])
						if (work.questionId === row.questionId)
							deps.work!.relinkInTransaction(tx, work.id, run.id);
					addEvent(tx, row.id, "answer", body.eventId, {
						questionId: body.questionId,
						value: parsed.value,
						inputDigest,
						runId: run.id,
					});
					if (bodyBytes(tx, row.id) > INTERACTION_POLICY.maxBodyBytes)
						throw new Error("interaction_body_too_large");
					return {
						ok: true,
						fresh: true,
						value: {
							interaction: view(interactionById(tx, row.id)!),
							runId: run.id,
							replay: false,
						},
					};
				},
			);
			if (!result.ok) throw new Error(result.code);
			if (result.fresh) queue.wake();
			return result.value;
		},

		/**
		 * `POST /api/toolchain-interactions/:id/cancel`: closes the question, advances the epoch
		 * and the generation so a late answer or model result is refused, and stops a resumed
		 * run still in flight. A timer already saved is not cancelled implicitly.
		 */
	};
}

/** The user-visible text of an answer, saved as the utterance that resumes the operation. */
function utterance(value: unknown): string {
	if (
		value &&
		typeof value === "object" &&
		typeof (value as { text?: unknown }).text === "string"
	)
		return (value as { text: string }).text;
	return `回答: ${JSON.stringify(value)}`;
}
