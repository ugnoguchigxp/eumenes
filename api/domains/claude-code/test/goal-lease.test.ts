import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { Capabilities } from "../../capabilities";
import type {
	GoalSupervisedExecutionSource,
	SupervisedExecutionSource,
} from "../../tool-runtime";
import type { Host, Observation } from "../contracts";
import { acceptObservation, applyDecision } from "../lifecycle";
import { migrations, read, save } from "../repository";
import { createTaskPort } from "../task";

test("a goal child has one invocation, with one continuation after a parked question and its own answer", () => {
	const db = new Database(":memory:");
	for (const migration of migrations) db.run(migration.sql);
	const now = Date.now();
	const deadline = now + 60_000;
	const authorization = {
		workspaceRef: "trial",
		targetRevision: "head",
		mode: "read" as const,
		readablePaths: ["/fixture/manual"],
		writablePaths: [],
		checks: [],
		deadline,
	};
	const lease = {
		ownerRef: "owner",
		executorId: "executor",
		epoch: "epoch",
		slot: "read" as const,
	};
	let released = 0;
	const host: Host = {
		validReferenceInTransaction: () => false,
		controlSourceInTransaction: () => null,
		validSourceInTransaction: () => true,
		deliverInTransaction: () => true,
		revokeInTransaction() {},
		supervised: {
			authorizeInTransaction: () => authorization,
			observeInTransaction: () => true,
		},
		workspace: {
			hold: () => lease,
			release: () => {
				released++;
			},
			released: () => released > 0,
		},
	};
	const ports = createTaskPort({
		getHost: () => host,
		available: () => true,
		supervisedAvailable: () => true,
		now: () => now,
		capabilities: {
			toolchainSetInTransaction: () => ({
				binding: {
					revisionId: "registered-binding",
					document: {
						id: "registered",
						adapterRef: "adapter:claude-code-task@1",
						execution: "task",
						limits: { parentCalls: 10, modelCalls: 10, childCalls: 5 },
						timeLimits: { runMs: 60_000, inferenceMs: 30_000 },
					},
				},
				profile: "",
				skills: [],
			}),
		} as unknown as Capabilities,
		cancel() {},
	});
	const base = {
		origin: "supervised" as const,
		messageId: null,
		runId: crypto.randomUUID(),
		request: "Read the file",
		digest: "request",
		delegation: {
			grantRef: "grant",
			parentWorkId: "parent",
			taskId: "task",
			parentGeneration: 0,
			taskGeneration: 0,
		},
	};
	const goal: GoalSupervisedExecutionSource = {
		...base,
		conversationId: null,
		goal: {
			principal: "owner",
			scopeKey: "scope",
			goalId: "goal",
			goalRevision: 1,
			attemptId: crypto.randomUUID(),
			permitId: crypto.randomUUID(),
			permitRevision: 1,
		},
	};
	const normal: SupervisedExecutionSource = { ...base, conversationId: "chat" };
	const start = (
		source: GoalSupervisedExecutionSource | SupervisedExecutionSource,
	) =>
		ports.supervised.startInTransaction(db, {
			source,
			request: source.request,
			references: [],
			toolchainRevisionId: "registered",
			bindingRevisionId: "registered-binding",
			operationId: crypto.randomUUID(),
		});
	try {
		const current = read(db, start(goal).id)!;
		expect(current.maxExecutions).toBe(1);
		expect(read(db, start(normal).id)?.maxExecutions).toBe(5);
		const invoke = {
			action: "invoke" as const,
			summary: "Selected",
			memo: "",
			instruction: "Read the file.",
		};
		applyDecision(db, host, current, invoke, now);
		const executionId = current.executionId!;
		expect(current.executions).toBe(1);
		const question = {
			id: crypto.randomUUID(),
			prompt: "Which section?",
			presentation: "waiting" as const,
			expiresAt: deadline,
			inputSchema: { type: "string" },
		};
		const observed: Observation = {
			executionId,
			seq: 1,
			state: "waiting",
			managedExecutionStopped: false,
			question,
			supervised: { lease, authorization },
		};
		expect(acceptObservation(db, host, current, observed, now)).toBe(true);
		expect(current.effect).toMatchObject({
			kind: "stop",
			reason: "question_wait",
		});
		expect(released).toBe(0);
		expect(
			acceptObservation(
				db,
				host,
				current,
				{
					executionId,
					seq: 2,
					state: "stopped",
					managedExecutionStopped: true,
					canResume: true,
				},
				now,
			),
		).toBe(true);
		expect(released).toBe(1);
		expect(current.executionId).toBeNull();
		save(db, current, now);
		const parentQuestionId = crypto.randomUUID();
		ports.supervised.presentInTransaction(db, goal, current.id, {
			operationId: crypto.randomUUID(),
			questionId: question.id,
			parentQuestionId,
			presentedAt: now,
			expiresAt: deadline,
		});
		const answer = {
			operationId: crypto.randomUUID(),
			questionId: question.id,
			parentQuestionId,
			messageId: "answer",
			answer: "Scope A",
		};
		ports.supervised.answerInTransaction(db, goal, current.id, answer);
		ports.supervised.answerInTransaction(db, goal, current.id, answer);
		const resumed = read(db, current.id)!;
		expect(resumed.maxExecutions).toBe(2);
		expect(resumed.answers).toHaveLength(1);
		expect(resumed.previousId).toBe(executionId);
	} finally {
		db.close();
	}
});
