import type { Database } from "bun:sqlite";
import { codingCanonicalJSON } from "../coding";
import {
	isGoalExecutionSource,
	type GoalExecutionSource,
	type GoalExecutionIdentity,
} from "../tool-runtime";
import type { Host, Work } from "./contracts";
import { closeQuestion, commonView, newId } from "./lifecycle";
import { read, save, terminal } from "./repository";

type Identity = GoalExecutionIdentity & { runId: string };

function find(db: Database, key: Identity) {
	const work = read(db, key.runId);
	if (!work || !isGoalExecutionSource(work.source)) return null;
	const {
		principal,
		scopeKey,
		goalId,
		goalRevision,
		attemptId,
		permitId,
		permitRevision,
	} = work.source;
	return principal === key.principal &&
		scopeKey === key.scopeKey &&
		goalId === key.goalId &&
		goalRevision === key.goalRevision &&
		attemptId === key.attemptId &&
		permitId === key.permitId &&
		permitRevision === key.permitRevision
		? work
		: null;
}

export function goalTaskView(work: Work) {
	return {
		...commonView(work),
		released: !work.holdsWorkspace && work.stop !== "unconfirmed",
		hasObservation: !!work.observation?.evidence?.length,
	};
}

export function createGoalTaskPort(deps: {
	getHost(): Host | undefined;
	available(): boolean;
	now(): number;
	start(
		db: Database,
		host: Host,
		source: GoalExecutionSource,
		mode: Work["mode"],
	): Work;
	cancel(db: Database, work: Work, reason: "cancel" | "forgotten"): void;
}) {
	return {
		startInTransaction(db: Database, source: GoalExecutionSource) {
			const host = deps.getHost();
			const mode = host?.goal?.modeInTransaction(db, source);
			if (!host || !mode || !isGoalExecutionSource(source))
				throw new Error("claude_goal_source_invalid");
			const existing = read(db, source.runId);
			if (existing) {
				if (
					existing.forgotten ||
					codingCanonicalJSON(existing.source) !== codingCanonicalJSON(source)
				)
					throw new Error("claude_goal_dispatch_conflict");
				return goalTaskView(existing);
			}
			return deps.available()
				? goalTaskView(deps.start(db, host, source, mode))
				: null;
		},
		lookupInTransaction(db: Database, key: Identity) {
			const work = find(db, key);
			return work && !work.forgotten ? goalTaskView(work) : null;
		},
		cancelInTransaction(db: Database, key: Identity) {
			const work = find(db, key);
			if (!work) return true;
			if (terminal(work)) return goalTaskView(work).released;
			if (work.effect?.kind === "stop") return false;
			deps.cancel(db, work, "cancel");
			return terminal(work) && goalTaskView(work).released;
		},
		answerInTransaction(
			db: Database,
			key: Identity,
			answer: { ref: string; messageId: string; answer: string },
		) {
			const work = find(db, key);
			const host = deps.getHost();
			if (
				!work ||
				!host ||
				work.forgotten ||
				!isGoalExecutionSource(work.source) ||
				host.goal?.modeInTransaction(db, work.source) !== work.mode
			)
				throw new Error("claude_goal_source_invalid");
			if (work.answers.some(({ messageId }) => messageId === answer.messageId))
				return;
			const question = work.question;
			if (
				!question ||
				question.id !== answer.ref ||
				question.expiresAt <= deps.now() ||
				(!work.executionId && !goalTaskView(work).released) ||
				terminal(work)
			)
				throw new Error("claude_goal_question_inactive");
			work.answers.push({
				messageId: answer.messageId,
				question: question.prompt,
				answer: answer.answer,
			});
			const resume = work.questionFromRunner && work.executionId;
			closeQuestion(db, host, work);
			if (resume)
				work.effect = {
					kind: "reply",
					id: newId(),
					questionId: question.id,
					answer: answer.answer,
				};
			work.status = resume ? "waiting_child" : "queued";
			work.summary = "回答を受け取り、Claude Code の作業を再開します。";
			work.observedAt = deps.now();
			save(db, work, deps.now());
		},
		forgetInTransaction(db: Database, key: Identity) {
			const work = find(db, key);
			if (!work || !isGoalExecutionSource(work.source)) return true;
			work.forgotten = true;
			work.source = {
				...work.source,
				request: "[forgotten]",
				expectedObservation: "[forgotten]",
			};
			work.request = "";
			work.memo = "";
			work.answers = [];
			work.observation = null;
			work.result = null;
			work.knownEvidenceRefs = [];
			work.eventExcerpts = [];
			work.notice = null;
			deps.cancel(db, work, "forgotten");
			return terminal(work) && goalTaskView(work).released;
		},
	};
}

export type GoalTaskView = ReturnType<typeof goalTaskView>;
