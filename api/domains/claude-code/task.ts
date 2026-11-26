import type { Database } from "bun:sqlite";
import type { Capabilities } from "../capabilities";
import {
	executionControl,
	isStandardExecutionSource,
	isGoalExecutionSource,
	type TaskLifecyclePort,
} from "../tool-runtime";
import { adapterRef, questionAnswer, type Host, type Work } from "./contracts";
import { closeQuestion, newId, view, workWorkspace } from "./lifecycle";
import { read, save, terminal } from "./repository";
import { createSupervisedTaskPort } from "./supervised-task";
import { createGoalTaskPort } from "./goal-task";

export function createTaskPort({
	capabilities,
	getHost,
	available,
	supervisedAvailable,
	now,
	cancel,
}: {
	capabilities: Capabilities;
	getHost(): Host | undefined;
	available(): boolean;
	supervisedAvailable(goal: boolean, workspaceRef?: string): boolean;
	now(): number;
	cancel(
		db: Database,
		work: Work,
		reason: "cancel" | "amend" | "forgotten",
		operationId?: string,
	): void;
}) {
	function start(
		db: Database,
		input: Omit<
			Parameters<TaskLifecyclePort["startInTransaction"]>[1],
			"source"
		> & { source: Work["source"] },
		host: Host,
		authorization?: NonNullable<Work["supervision"]>["authorization"],
		goalMode?: Work["mode"],
	) {
		const revision = input.toolchainRevisionId;
		const set =
			revision && capabilities.toolchainSetInTransaction(db, revision);
		const binding = set && set.binding?.document;
		if (
			!set ||
			!set.binding ||
			!binding ||
			binding.execution !== "task" ||
			binding.adapterRef !== adapterRef ||
			set.binding?.revisionId !== input.bindingRevisionId
		)
			throw new Error("claude_binding_invalid");
		const at = now();
		const request = input.request.trim();
		if (!request || request.length > 8_000)
			throw new Error("claude_request_invalid");
		if (
			input.references.some(
				(ref) =>
					typeof input.source.conversationId !== "string" ||
					!host.validReferenceInTransaction(db, input.source, ref),
			)
		)
			throw new Error("claude_reference_invalid");
		const deadline = Math.min(
			at + binding.timeLimits.runMs,
			input.deadline ?? Infinity,
			authorization?.deadline ?? Infinity,
		);
		if (deadline <= at) throw new Error("claude_deadline_exceeded");
		const work: Work = {
			id: isGoalExecutionSource(input.source) ? input.source.runId : newId(),
			source: input.source,
			binding: set.binding.revisionId,
			request,
			references: input.references,
			profile: set.profile,
			skills: [...set.skills],
			deadline,
			generation: 0,
			revision: 0,
			status: "queued",
			summary: "依頼を受け付けました。",
			observedAt: at,
			startedAt: at,
			memo: "",
			question: null,
			questionFromRunner: false,
			result: null,
			observation: null,
			calls: 0,
			executions: 0,
			turnsReserved: 0,
			turnsUsedBeforeExecution: 0,
			maxCalls: Math.min(binding.limits.parentCalls, binding.limits.modelCalls),
			maxExecutions:
				input.source.conversationId === null
					? Math.min(1, binding.limits.childCalls)
					: binding.limits.childCalls,
			attemptMs: binding.timeLimits.inferenceMs,
			decisionId: null,
			decisionMode: "work",
			progressCalls: 0,
			progressSeq: -1,
			progressAt: at,
			effect: null,
			executionId: null,
			previousId: null,
			answers: [],
			amendments: [],
			notice: null,
			forgotten: false,
			holdsWorkspace: false,
			stop: undefined,
			mode:
				goalMode ??
				(binding.id === "claude-code.repair-managed" ? "analysis" : "work"),
			conversationSummary: binding.conversationSummary,
			...(authorization && input.toolchainRevisionId
				? {
						supervision: {
							authorization,
							toolchainRevisionId: input.toolchainRevisionId,
						},
					}
				: {}),
		};
		if (work.supervision) {
			const lease = workWorkspace(host, work).hold(
				db,
				work.id,
				work.supervision.authorization,
			);
			if (!lease) throw new Error("claude_workspace_busy");
			if (typeof lease !== "object")
				throw new Error("claude_workspace_lease_unavailable");
			work.supervision.lease = lease;
			work.holdsWorkspace = true;
		}
		save(db, work, at);
		return work;
	}
	const task: TaskLifecyclePort = {
		startInTransaction(db, input) {
			const host = getHost();
			if (
				!available() ||
				!host ||
				!isStandardExecutionSource(input.source) ||
				!input.source.messageId ||
				input.source.origin ||
				!host.validSourceInTransaction(db, input.source)
			)
				throw new Error("claude_task_unavailable");
			return view(start(db, input, host));
		},
		controlInTransaction(db, conversationId, raw, messageId) {
			const host = getHost();
			if (!host) throw new Error("claude_task_unavailable");
			const input = executionControl.parse(raw);
			const work = getDirect(db, input.workRef, conversationId);
			const { source } = work;
			if (!isStandardExecutionSource(source))
				throw new Error("claude_work_not_found");
			if (input.action === "status") return view(work);
			if (work.revision !== input.expectedRevision)
				throw new Error("execution_revision_conflict");
			if (terminal(work)) throw new Error("execution_terminal");
			if (input.action === "cancel") {
				cancel(db, work, "cancel");
				return view(work);
			}
			if (
				work.deadline <= now() ||
				!isStandardExecutionSource(work.source) ||
				!host.validSourceInTransaction(db, work.source)
			)
				throw new Error("claude_source_invalid");
			if (work.status === "stopping") throw new Error("claude_stopping");
			const authority = host.controlSourceInTransaction(
				db,
				conversationId,
				messageId,
				work.source,
			);
			if (!authority) throw new Error("claude_source_invalid");
			if (input.action === "amend") {
				if (!input.request || work.amendments.length >= 8)
					throw new Error("claude_amend_invalid");
				source.amendments = [...(source.amendments ?? []), authority];
				work.amendments.push({ messageId, text: input.request });
				cancel(db, work, "amend");
				return view(work);
			}
			const answer = questionAnswer.safeParse(input.input);
			const question = work.question;
			if (
				!answer.success ||
				!question ||
				question.id !== input.questionRef ||
				question.expiresAt <= now()
			)
				throw new Error("invalid_answer");
			source.responses = [...(source.responses ?? []), authority];
			if (work.questionFromRunner) {
				work.effect = {
					kind: "reply",
					id: newId(),
					questionId: question.id,
					answer: answer.data,
				};
				work.status = "waiting_child";
				work.summary = "回答を受け取り、Claude Code の作業を再開しています。";
			} else {
				work.answers.push({
					messageId,
					question: question.prompt,
					answer: answer.data,
				});
				work.status = "deciding";
				work.summary = "回答を受け取り、次の作業を判断しています。";
			}
			closeQuestion(db, host, work);
			work.observedAt = now();
			save(db, work, now());
			return view(work);
		},
		viewInTransaction(db, id) {
			const work = read(db, id);
			return work && !work.forgotten && isStandardExecutionSource(work.source)
				? view(work)
				: null;
		},
		cancelInTransaction(db, conversationId, id) {
			cancel(db, getDirect(db, id, conversationId), "cancel");
		},
		forgetInTransaction(db, id) {
			const host = getHost();
			const work = read(db, id);
			if (!work || !host || !isStandardExecutionSource(work.source)) return;
			closeQuestion(db, host, work);
			work.forgotten = true;
			work.request = "";
			work.memo = "";
			work.references = [];
			work.answers = [];
			work.amendments = [];
			work.result = null;
			work.observation = null;
			work.knownEvidenceRefs = [];
			work.eventExcerpts = [];
			work.eventCursor = 0;
			work.pendingRunnerQuestion = null;
			cancel(db, work, "forgotten");
		},
	};
	return {
		task,
		goal: createGoalTaskPort({
			getHost,
			available,
			now,
			cancel,
			start: (db, host, source, mode) =>
				start(
					db,
					{
						source,
						request: source.request,
						references: [],
						toolchainRevisionId: source.toolchainRevisionId,
						bindingRevisionId: source.bindingRevisionId,
					},
					host,
					undefined,
					mode,
				),
		}),
		supervised: createSupervisedTaskPort({
			getHost,
			now,
			cancel,
			available: supervisedAvailable,
			start,
		}),
	};
}

function getDirect(db: Database, id: string, conversationId: string) {
	const work = read(db, id);
	if (
		!work ||
		work.forgotten ||
		!isStandardExecutionSource(work.source) ||
		work.source.conversationId !== conversationId
	)
		throw new Error("claude_work_not_found");
	return work;
}
