import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { claudeAuthorization, codingCanonicalJSON } from "../coding";
import {
	isSupervisedExecutionSource,
	type OwnedSupervisedExecutionSource,
} from "../tool-runtime";
import {
	questionAnswer,
	type ClaudeRunAuthorization,
	type Host,
	type Work,
	type SupervisedStart,
	type SupervisedPresentation,
	type SupervisedAnswer,
	type SupervisedView,
} from "./contracts";
import {
	closeQuestion,
	finish,
	workWorkspace,
	supervisedAuthority,
	supervisedView,
} from "./lifecycle";
import { operation, read, recordOperation, save, terminal } from "./repository";

const operationId = z.uuid();

export function createSupervisedTaskPort({
	getHost,
	available,
	now,
	cancel,
	start,
}: {
	getHost(): Host | undefined;
	available(goal: boolean, workspaceRef?: string): boolean;
	now(): number;
	cancel(db: Database, work: Work, reason: "cancel", operationId: string): void;
	start(
		db: Database,
		input: SupervisedStart,
		host: Host,
		authority: ClaudeRunAuthorization,
	): Work;
}) {
	const supervised = {
		forgetInTransaction(
			db: Database,
			source: OwnedSupervisedExecutionSource,
			id: string,
		) {
			const host = getHost();
			const work = getChild(db, source, id);
			if (
				!host ||
				!work ||
				work.forgotten ||
				work.holdsWorkspace ||
				work.stop === "unconfirmed"
			)
				return;
			work.forgotten = true;
			work.source = { ...source, request: "", digest: "" };
			work.request = "";
			work.memo = "";
			work.references = [];
			work.answers = [];
			work.amendments = [];
			work.observation = null;
			work.supervision = undefined;
			finish(db, host, work, "cancelled", "");
			work.result = null;
			save(db, work, now());
		},
		startInTransaction(db: Database, input: SupervisedStart) {
			const host = getHost();
			if (
				!host ||
				!isSupervisedExecutionSource(input.source) ||
				!input.operationId ||
				input.request !== input.source.request
			)
				throw new Error("claude_source_invalid");
			const prior = matchOperation(db, input.operationId, ["start", input]);
			const approval = claudeAuthorization.safeParse(
				host.supervised?.authorizeInTransaction(db, {
					action: "start",
					source: input.source,
					workId: prior?.workId,
					request: input.request,
					operationId: input.operationId,
					toolchainRevisionId: input.toolchainRevisionId,
					bindingRevisionId: input.bindingRevisionId,
				}),
			);
			if (
				!approval.success ||
				approval.data.deadline <= now() ||
				!available(!!input.source.goal, approval.data.workspaceRef)
			)
				throw new Error("claude_source_invalid");
			if (prior) {
				const work = getChild(db, input.source, prior.workId);
				if (!work) throw new Error("claude_work_not_found");
				return supervisedView(work);
			}
			const work = start(db, input, host, approval.data);
			recordOperation(
				db,
				input.operationId,
				work.id,
				fingerprint(["start", input]),
			);
			return supervisedView(work);
		},
		viewInTransaction(
			db: Database,
			source: OwnedSupervisedExecutionSource,
			id: string,
		): SupervisedView | null {
			const host = getHost();
			const work = getChild(db, source, id);
			const authority =
				host && work && supervisedAuthority(host, db, work, "view");
			if (!work?.supervision || !host || !authority) return null;
			const lease = work.supervision.lease;
			return {
				view: supervisedView(work),
				executionId: work.executionId ?? work.observation?.executionId ?? null,
				...(work.question
					? {
							questionExecutionId: work.questionFromRunner
								? work.executionId
								: (work.parkedQuestionExecutionId ?? null),
						}
					: {}),
				// A cached intermediate poll can predate a check that superseded it.
				evidence: work.observation?.managedExecutionStopped
					? (work.observation.structuredEvidence ?? [])
					: (work.supervision.evidence ?? []),
				...(source.goal
					? {
							diagnosticChecks: (work.supervision.evidence ?? []).filter(
								({ kind, passed }) => kind === "check" && passed === false,
							),
						}
					: {}),
				releaseConfirmed:
					!work.holdsWorkspace &&
					work.stop !== "unconfirmed" &&
					(!lease || workWorkspace(host, work).released?.(db, lease) === true),
				answerDelivery: work.supervision.answerDelivery,
				...(work.status === "queued" && work.supervision.blocked
					? {
							blocking: {
								state:
									work.supervision.blocked === "runner_busy"
										? "waiting"
										: "held",
								reason: work.summary,
							},
						}
					: {}),
			};
		},
		presentInTransaction(
			db: Database,
			source: OwnedSupervisedExecutionSource,
			id: string,
			input: SupervisedPresentation,
		) {
			const [, work, replay] = control(db, source, id, "present", input);
			if (replay) return supervisedView(work);
			const question = work.question;
			const at = now();
			if (
				!question ||
				question.id !== input.questionId ||
				question.presentation !== "waiting" ||
				input.presentedAt > at ||
				input.expiresAt <= at ||
				input.expiresAt !==
					Math.min(
						question.expiresAt,
						work.deadline,
						input.presentedAt + 15 * 60_000,
					)
			)
				throw new Error("claude_question_stale");
			work.question = {
				...question,
				presentation: "presented",
				expiresAt: input.expiresAt,
			};
			work.supervision!.presentation = {
				...input,
				sent: !work.questionFromRunner,
			};
			persistControl(db, work, "present", input, at);
			return supervisedView(work);
		},
		answerInTransaction(
			db: Database,
			source: OwnedSupervisedExecutionSource,
			id: string,
			input: SupervisedAnswer,
		) {
			const [host, work, replay] = control(db, source, id, "answer", input);
			if (replay) return supervisedView(work);
			const question = work.question;
			const presented = work.supervision!.presentation;
			const answer = questionAnswer.safeParse(input.answer);
			const at = now();
			if (
				!question ||
				!answer.success ||
				question.id !== input.questionId ||
				question.presentation !== "presented" ||
				question.expiresAt <= at ||
				presented?.parentQuestionId !== input.parentQuestionId
			)
				throw new Error("invalid_answer");
			work.supervision!.answerDelivery = {
				operationId: input.operationId,
				state: work.questionFromRunner ? "pending" : "delivered",
			};
			if (work.questionFromRunner) {
				work.effect = {
					kind: "reply",
					id: input.operationId,
					questionId: question.id,
					answer: answer.data,
				};
				work.status = "waiting_child";
				// Keep the persisted presentation until the runner acknowledges the reply.
				work.question = null;
				work.notice = null;
				work.questionFromRunner = false;
			} else {
				if (source.goal && work.parkedQuestionExecutionId)
					work.maxExecutions = Math.max(
						work.maxExecutions,
						work.executions + 1,
					);
				work.answers.push({
					messageId: input.messageId,
					question: question.prompt,
					answer: answer.data,
				});
				work.status = "deciding";
				closeQuestion(db, host, work);
			}
			persistControl(db, work, "answer", input, at);
			return supervisedView(work);
		},
		cancelInTransaction(
			db: Database,
			source: OwnedSupervisedExecutionSource,
			id: string,
			input: { operationId: string },
		) {
			const [, work, replay] = control(db, source, id, "cancel", input);
			if (!replay) {
				cancel(db, work, "cancel", input.operationId);
				recordOperation(
					db,
					input.operationId,
					work.id,
					fingerprint(["cancel", source, id, input]),
				);
			}
			return supervisedView(work);
		},
	};

	function control(
		db: Database,
		source: OwnedSupervisedExecutionSource,
		id: string,
		action: "present" | "answer" | "cancel",
		input: {
			operationId: string;
			questionId?: string;
			parentQuestionId?: string;
			messageId?: string;
		},
	) {
		const host = getHost();
		const work = getChild(db, source, id);
		if (
			!host ||
			!work ||
			!operationId.safeParse(input.operationId).success ||
			!supervisedAuthority(host, db, work, action, input) ||
			(action !== "cancel" && work.deadline <= now())
		)
			throw new Error("claude_source_invalid");
		const replay = matchOperation(db, input.operationId, [
			action,
			source,
			id,
			input,
		]);
		if (replay && replay.workId !== id)
			throw new Error("claude_operation_conflict");
		if (
			!replay &&
			action !== "cancel" &&
			(terminal(work) || work.status === "stopping")
		)
			throw new Error("claude_question_stale");
		return [host, work, !!replay] as const;
	}
	return supervised;
}

function persistControl(
	db: Database,
	work: Work,
	action: "present" | "answer",
	input: SupervisedPresentation | SupervisedAnswer,
	now: number,
) {
	save(db, work, now);
	recordOperation(
		db,
		input.operationId,
		work.id,
		fingerprint([action, work.source, work.id, input]),
	);
}

function getChild(
	db: Database,
	source: OwnedSupervisedExecutionSource,
	workId: string,
) {
	const work = read(db, workId);
	return work &&
		!work.forgotten &&
		work.supervision &&
		isSupervisedExecutionSource(source) &&
		isSupervisedExecutionSource(work.source) &&
		codingCanonicalJSON(source) === codingCanonicalJSON(work.source)
		? work
		: null;
}

function fingerprint(value: unknown) {
	return createHash("sha256").update(codingCanonicalJSON(value)).digest("hex");
}

function matchOperation(db: Database, id: string, value: unknown) {
	const prior = operation(db, id);
	if (prior && prior.digest !== fingerprint(value))
		throw new Error("claude_operation_conflict");
	return prior;
}
