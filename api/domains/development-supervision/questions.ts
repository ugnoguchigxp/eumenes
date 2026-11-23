import type { Database } from "bun:sqlite";
import type { SupervisionChildObservation, SupervisionHost } from "./contracts";
import { childObservation, liveGrant } from "./authority";
import { grantOf, questionsOf, saveQuestion } from "./repository";
import type { Grant, Parent, Question } from "./state";

const answerWindowMs = 15 * 60_000;

export function recordQuestion(
	db: Database,
	parent: Parent,
	grant: Grant,
	child: SupervisionChildObservation,
) {
	const question = child.view.question;
	if (!question || !grant.workId || child.view.status !== "waiting_user")
		return;
	const grantRef = grant.source.delegation.grantRef;
	if (
		questionsOf(db, parent.id).some(
			({ grantRef: id, childQuestionId }) =>
				id === grantRef && childQuestionId === question.id,
		)
	)
		return;
	saveQuestion(db, {
		id: crypto.randomUUID(),
		parentId: parent.id,
		grantRef,
		workId: grant.workId,
		childQuestionId: question.id,
		executionId: child.questionExecutionId ?? null,
		prompt: question.prompt,
		inputSchema: question.inputSchema,
		absoluteDeadline: Math.min(
			parent.deadline,
			child.view.deadline,
			grant.scope.deadline,
			question.expiresAt,
		),
		status: "queued",
		presentedAt: null,
		expiresAt: null,
		presentOperationId: null,
		answer: null,
	});
}

function closeQuestion(
	host: SupervisionHost,
	db: Database,
	parent: Parent,
	question: Question,
) {
	question.status = "closed";
	saveQuestion(db, question);
	if (parent.question?.id !== question.id) return;
	if (parent.questionOp) {
		host.revokeInTransaction(db, parent.questionOp);
		const notice = parent.notices.find(({ id }) => id === parent.questionOp);
		if (notice) notice.active = false;
	}
	parent.questionOp = null;
	parent.question = null;
}

export function syncQuestions(
	host: SupervisionHost,
	db: Database,
	parent: Parent,
	now: number,
	notify: (parent: Parent) => void,
) {
	let next: { question: Question; grant: Grant } | null = null;
	parent.goalQuestionReleased = false;
	for (const question of questionsOf(db, parent.id)) {
		if (question.status === "closed") continue;
		const grant = grantOf(db, question.grantRef);
		const child = grant ? childObservation(host, db, grant) : null;
		if (question.status === "answered") {
			const delivery = child?.answerDelivery;
			if (
				delivery?.operationId === question.answer?.operationId &&
				delivery?.state === "failed" &&
				question.answer &&
				!question.answer.failReported
			) {
				question.answer.failReported = true;
				saveQuestion(db, question);
				const task = parent.tasks.find(
					({ grantRef }) => grantRef === question.grantRef,
				);
				if (task) {
					task.reason =
						"子への回答配送を確認できません。停止の確認後に再質問できます。";
					task.state = "held";
					notify(parent);
				}
			}
			continue;
		}
		if (
			!grant ||
			!liveGrant(host, db, grant, parent, now) ||
			question.absoluteDeadline <= now ||
			(question.expiresAt !== null && question.expiresAt <= now) ||
			child?.view.status !== "waiting_user" ||
			child.view.question?.id !== question.childQuestionId ||
			(child.questionExecutionId ?? null) !== question.executionId
		) {
			closeQuestion(host, db, parent, question);
			continue;
		}
		if (parent.source.origin === "goal" && parent.question?.id === question.id)
			parent.goalQuestionReleased = child.releaseConfirmed;
		if (!next && question.status === "queued") next = { question, grant };
	}
	if (!next || parent.question) return;
	const { question, grant } = next;
	question.status = "presented";
	question.presentedAt = now;
	question.expiresAt = Math.min(
		question.absoluteDeadline,
		now + answerWindowMs,
	);
	question.presentOperationId = crypto.randomUUID();
	saveQuestion(db, question);
	host.child.presentInTransaction(db, grant.source, question.workId, {
		operationId: question.presentOperationId,
		questionId: question.childQuestionId,
		parentQuestionId: question.id,
		presentedAt: now,
		expiresAt: question.expiresAt,
	});
	parent.question = {
		id: question.id,
		prompt: question.prompt,
		expiresAt: question.expiresAt,
		inputSchema: question.inputSchema,
	};
	parent.questionOp = question.presentOperationId;
	if (parent.source.origin === "goal")
		parent.goalQuestionReleased =
			childObservation(host, db, grant)?.releaseConfirmed === true;
	const task = parent.tasks.find(
		({ grantRef }) => grantRef === question.grantRef,
	);
	if (task) {
		task.state = "held";
		task.reason = "利用者の回答待ち";
	}
}

export function answerQuestion(
	host: SupervisionHost,
	db: Database,
	parent: Parent,
	input: {
		questionRef: string | undefined;
		answer: string;
		messageId: string;
		operationId: string;
		taskId?: string;
	},
	now: number,
) {
	const question = questionsOf(db, parent.id).find(
		({ id }) => id === input.questionRef,
	);
	const grant = question && grantOf(db, question.grantRef);
	if (
		!question ||
		!grant ||
		question.id !== parent.question?.id ||
		(input.taskId !== undefined &&
			grant.source.delegation.taskId !== input.taskId) ||
		question.status !== "presented" ||
		!question.expiresAt ||
		question.expiresAt <= now ||
		!liveGrant(host, db, grant, parent, now)
	)
		throw new Error("invalid_answer");
	question.answer = {
		operationId: input.operationId,
		messageId: input.messageId,
		failReported: false,
	};
	question.status = "answered";
	saveQuestion(db, question);
	host.child.answerInTransaction(db, grant.source, question.workId, {
		operationId: input.operationId,
		questionId: question.childQuestionId,
		parentQuestionId: question.id,
		messageId: input.messageId,
		answer: input.answer,
	});
	if (parent.questionOp) {
		host.revokeInTransaction(db, parent.questionOp);
		const notice = parent.notices.find(({ id }) => id === parent.questionOp);
		if (notice) notice.active = false;
	}
	parent.question = null;
	parent.questionOp = null;
}

export function revokeQuestions(
	host: SupervisionHost,
	db: Database,
	parent: Parent,
	grantRefs: Set<string>,
) {
	for (const question of questionsOf(db, parent.id)) {
		if (question.status !== "closed" && grantRefs.has(question.grantRef))
			closeQuestion(host, db, parent, question);
	}
}
