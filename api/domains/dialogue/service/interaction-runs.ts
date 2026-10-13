import type { Database } from "bun:sqlite";
import {
	INTERACTION_POLICY,
	choiceQuestionFields,
} from "../contracts/command-interactions";
import type { BoundCommandSet } from "../contracts/toolchains";
import type { Run } from "../contracts";
import {
	eventsOf,
	insertInteraction,
	interactionById,
	interactionCounts,
	openInteractionOfRun,
	openQuestionRows,
} from "../repository/interactions";
import type { OpenQuestion } from "./conversation-tools";
import type { DialogueDeps } from "./context";
import { ownerOf, type InteractionCore } from "./interaction-core";

const MAX_OPEN_QUESTIONS_OFFERED = 3;
const MAX_CHOICES = 20;

/**
 * The host-issued choices of a choice question, and the schema it is really asked with: a
 * question that needs choices but has none falls back to free text.
 */
function questionWithChoices(
	deps: DialogueDeps,
	tx: Database,
	set: BoundCommandSet,
	schemaRef: string,
) {
	if (!Object.hasOwn(choiceQuestionFields, schemaRef))
		return { schemaRef, choicesJson: null };
	const choices = (
		deps.toolchains?.bound?.questionChoicesInTransaction(
			tx,
			set.bindingRevisionId,
			schemaRef,
		) ?? []
	)
		.slice(0, MAX_CHOICES)
		.map((choice) => ({
			ref: choice.ref.slice(0, 64),
			label: choice.label.slice(0, 120),
		}));
	return choices.length
		? { schemaRef, choicesJson: JSON.stringify(choices) }
		: { schemaRef: "builtin:answerText", choicesJson: null };
}

/**
 * The command sub-agent's side of an interaction: asking a question, reading what a resumed run
 * needs, and freezing and settling the operation it invokes. All of it runs in the transaction
 * that settles the run.
 */
export function createInteractionRuns(
	deps: DialogueDeps,
	core: InteractionCore,
) {
	const { clock, id } = deps;
	const { frozenValid, addEvent, checkBody, settle } = core;
	return {
		/**
		 * A command sub-agent asked its question. A first question creates the interaction with
		 * the run that was serving; a later one (a resumed run) reopens it. Atomic with the run's
		 * own settlement. Throws a safe code when the limits stop it.
		 */
		askInTransaction(
			tx: Database,
			input: {
				run: Run;
				interactionId?: string;
				toolchainRevisionId: string;
				set: BoundCommandSet;
				request: string;
				prompt: string;
				schemaRef: string;
			},
		): string {
			const now = clock();
			const expiresAt = new Date(
				Date.parse(now) + INTERACTION_POLICY.answerTtlMs,
			).toISOString();
			const questionId = id();
			const asked = questionWithChoices(deps, tx, input.set, input.schemaRef);
			if (input.interactionId) {
				const row = interactionById(tx, input.interactionId);
				if (!row || row.status !== "ready" || row.currentRunId !== input.run.id)
					throw new Error("interaction_closed");
				if (row.questionCount >= INTERACTION_POLICY.maxQuestions)
					throw new Error("question_limit_reached");
				const changed = tx
					.query(
						`UPDATE command_interactions SET status='waiting_input',revision=revision+1,
						 question_id=?,question_prompt=?,question_schema_ref=?,question_choices_json=?,question_count=question_count+1,
						 expires_at=?,updated_at=? WHERE id=? AND revision=? AND status='ready'`,
					)
					.run(
						questionId,
						input.prompt,
						asked.schemaRef,
						asked.choicesJson,
						expiresAt,
						now,
						row.id,
						row.revision,
					).changes;
				if (changed !== 1) throw new Error("interaction_closed");
				addEvent(tx, row.id, "question", `question:${questionId}`, {
					prompt: input.prompt,
					schemaRef: asked.schemaRef,
					...(asked.choicesJson
						? { choices: JSON.parse(asked.choicesJson) }
						: {}),
				});
				checkBody(tx, row.id);
				return row.id;
			}
			const counts = interactionCounts(tx);
			if (
				counts.open >= INTERACTION_POLICY.maxOpen ||
				counts.total >= INTERACTION_POLICY.maxTotal
			)
				throw new Error("interaction_capacity");
			const toolchains = deps.toolchains;
			if (!toolchains) throw new Error("toolchain_unavailable");
			const functionName = toolchains.resolveInTransaction(
				tx,
				input.toolchainRevisionId,
			).toolchain.functionName;
			if (!functionName) throw new Error("toolchain_unavailable");
			const interactionId = id();
			insertInteraction(tx, {
				id: interactionId,
				conversationId: input.run.conversationId,
				originMessageId: input.run.inputMessageId,
				originRunId: input.run.id,
				currentRunId: input.run.id,
				chainRevisionId: input.toolchainRevisionId,
				functionName,
				packageRevisionId: input.set.packageRevisionId,
				bindingRevisionId: input.set.bindingRevisionId,
				artifactRevisionId: input.set.artifactRevisionId,
				revision: 0,
				authorityEpoch: 0,
				executionGeneration: 0,
				status: "waiting_input",
				questionId,
				questionPrompt: input.prompt,
				questionSchemaRef: asked.schemaRef,
				questionChoicesJson: asked.choicesJson,
				questionCount: 1,
				requestText: input.request,
				inputJson: null,
				requestId: id(),
				issuedAt: null,
				receiptOwner: null,
				receiptOperationId: null,
				receiptDigest: null,
				endCode: null,
				expiresAt,
				createdAt: now,
				updatedAt: now,
				endedAt: null,
				bodyDeletedAt: null,
			});
			addEvent(tx, interactionId, "question", `question:${questionId}`, {
				prompt: input.prompt,
				schemaRef: asked.schemaRef,
				...(asked.choicesJson
					? { choices: JSON.parse(asked.choicesJson) }
					: {}),
			});
			checkBody(tx, interactionId);
			return interactionId;
		},

		/**
		 * What a resumed command run reads: the frozen refs, the original request, and the
		 * questions and answers so far (as data). Null when the interaction cannot continue.
		 */
		resumeContextInTransaction(
			tx: Database,
			interactionId: string,
			runId: string,
		):
			| {
					ok: true;
					generation: number;
					epoch: number;
					chainRevisionId: string;
					request: string;
					originalRequest: string | null;
					exchanges: Array<{ question: string; answer: unknown }>;
			  }
			| { ok: false; code: string } {
			const row = interactionById(tx, interactionId);
			if (!row || row.currentRunId !== runId || row.status !== "ready")
				return { ok: false, code: "interaction_closed" };
			if (!frozenValid(tx, row))
				return { ok: false, code: "version_invalidated" };
			const exchanges: Array<{ question: string; answer: unknown }> = [];
			for (const event of eventsOf(tx, row.id)) {
				const payload = event.payloadJson
					? (JSON.parse(event.payloadJson) as Record<string, unknown>)
					: null;
				if (event.kind === "question" && payload)
					exchanges.push({
						question: String(payload.prompt ?? ""),
						answer: null,
					});
				else if (event.kind === "answer" && payload && exchanges.length)
					exchanges[exchanges.length - 1]!.answer = payload.value ?? null;
			}
			return {
				ok: true,
				generation: row.executionGeneration,
				epoch: row.authorityEpoch,
				chainRevisionId: row.chainRevisionId,
				request: row.requestText ?? "",
				originalRequest:
					deps.conversation
						.messagesInTransaction(tx, row.conversationId)
						.find((m) => m.id === row.originMessageId)?.text ?? null,
				exchanges,
			};
		},

		/** A late model result of an older generation, epoch or run is not adopted. */
		guardInTransaction(
			tx: Database,
			interactionId: string,
			runId: string,
			expect: { generation: number; epoch: number },
		) {
			const row = interactionById(tx, interactionId);
			return (
				!!row &&
				row.status === "ready" &&
				row.currentRunId === runId &&
				row.executionGeneration === expect.generation &&
				row.authorityEpoch === expect.epoch
			);
		},

		/** The operation is about to be saved: freeze its input and the time it was decided. */
		beginInvokeInTransaction(
			tx: Database,
			interactionId: string,
			runId: string,
			input: unknown,
		): { requestId: string; issuedAt: string } {
			const row = interactionById(tx, interactionId);
			if (!row || row.status !== "ready" || row.currentRunId !== runId)
				throw new Error("interaction_closed");
			const now = clock();
			const changed = tx
				.query(
					`UPDATE command_interactions SET status='invoking',revision=revision+1,
					 input_json=?,issued_at=?,question_id=NULL,updated_at=? WHERE id=? AND revision=? AND status='ready'`,
				)
				.run(JSON.stringify(input), now, now, row.id, row.revision).changes;
			if (changed !== 1) throw new Error("interaction_closed");
			addEvent(tx, row.id, "invoke", `invoke:${runId}`, undefined);
			checkBody(tx, row.id);
			// The domain operation carries these, so a replay of it is the same logical operation.
			return { requestId: row.requestId, issuedAt: now };
		},

		/**
		 * The operation's outcome in the same transaction that saved it: completed with the
		 * receipt reference, or ended with the safe error code (nothing was saved).
		 */
		finishInvokeInTransaction(
			tx: Database,
			interactionId: string,
			outcome:
				| {
						state: "saved";
						adapterRef: string;
						operationId: string;
						digest: string;
				  }
				| { state: "failed"; errorCode: string },
		) {
			const row = interactionById(tx, interactionId);
			if (!row || row.status !== "invoking") return;
			if (outcome.state === "saved")
				settle(tx, row, "completed", null, {
					owner: ownerOf(outcome.adapterRef),
					operationId: outcome.operationId,
					digest: outcome.digest,
				});
			else settle(tx, row, "cancelled", outcome.errorCode);
		},

		/** The run serving an open interaction ended without finishing it. */
		endForRunInTransaction(tx: Database, runId: string, code: string) {
			const row = openInteractionOfRun(tx, runId);
			if (row) settle(tx, row, "cancelled", code);
		},
		/** The open questions of a conversation, as reference data for the conversation model. */
		openQuestionsInTransaction(
			tx: Database,
			conversationId: string,
		): OpenQuestion[] {
			return openQuestionRows(
				tx,
				conversationId,
				clock(),
				MAX_OPEN_QUESTIONS_OFFERED,
			).flatMap((row) =>
				row.questionId && row.questionPrompt
					? [
							{
								questionRef: row.questionId,
								functionName: row.functionName,
								prompt: row.questionPrompt,
							},
						]
					: [],
			);
		},
	};
}
