import { afterEach } from "bun:test";
export { instructionFrame } from "../service/approval";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import {
	createTasks,
	migration as tasksMigration,
	type TasksService,
	type WorkTask,
} from "../../tasks";
import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { QueueService } from "../../queue";
import type { CodingSupervision } from "..";
import { createQueue, migration as queueMigration } from "../../queue";
import {
	createTaskReports,
	migration as reportsMigration,
} from "../../task-reports";
import {
	createSettings,
	migration as settingsMigration,
	epochsMigration,
} from "../../settings";
import {
	createInference,
	migration as inferenceMigration,
	parentsMigration,
	diagnosticsMigration,
	controlMigration,
	backgroundControlMigration,
} from "../../inference";
import type { LarmPort } from "../../larm";
import { createCodingSupervision, migration } from "..";
import type {
	Decision,
	Observation,
	StepIntent,
	StepReceipt,
	WorkflowPort,
} from "../contracts";
import { fence } from "../service/policy";
const clean: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const fn of clean.splice(0)) await fn();
});
export const hash = "a".repeat(64),
	changedHash = "b".repeat(64),
	sha = "c".repeat(40);
export const observation = (
	overrides: Partial<Observation> = {},
): Observation => ({
	executionId: "execution-1",
	eventSeq: 1,
	sessionId: "implementation-session",
	snapshotHash: hash,
	turnFinished: true,
	childrenStopped: true,
	evidenceComplete: true,
	exitCode: 0,
	question: null,
	evidenceRefs: ["implementation-evidence"],
	facts: ["実装用CLIの終了を確認"],
	excerpt: "",
	...overrides,
});
export const proposal = (
	action: Decision["action"],
	instruction: string | null = null,
	questionId: string | null = null,
): Decision => ({
	action,
	reason: "保存済みの証拠に基づく判断",
	evidenceRefs: ["implementation-evidence"],
	instruction,
	questionId,
});
export function receipt(
	intent: StepIntent,
	overrides: Partial<StepReceipt> = {},
): StepReceipt {
	return {
		operationId: intent.id,
		kind: intent.kind,
		snapshotHash: intent.snapshotHash,
		evidenceRefs: [`evidence:${intent.id}`],
		turnFinished: true,
		childrenStopped: true,
		evidenceComplete: true,
		checks:
			intent.kind === "run_checks"
				? {
						digest: hash,
						results: [
							{ id: "typecheck", passed: true },
							{ id: "tests", passed: true },
						],
					}
				: null,
		review:
			intent.kind === "request_review"
				? {
						policyDigest: hash,
						sessionId: "review-session",
						readOnly: true,
						findings: [],
					}
				: null,
		commit:
			intent.kind === "request_commit" ? { sha, branch: "codex/task" } : null,
		push:
			intent.kind === "request_push"
				? { sha, branch: "codex/task", remote: "origin", confirmed: true }
				: null,
		conditionsMet: [true],
		...overrides,
	};
}
export async function setup(
	options: {
		maxDecisions?: number;
		/** Existing scenarios run without the approval gate; pass true to exercise it. */
		approveInstructions?: boolean;
		tokenCount?: number | null;
		operations?: Array<
			"read" | "edit" | "check" | "review" | "commit" | "push"
		>;
		model?: (call: number, signal: AbortSignal) => Promise<string>;
		migrations?: readonly string[];
		tasksFactory?: (context: {
			store: SqliteStore;
			queue: QueueService;
			workflow: WorkflowPort;
			now: () => number;
			supervision: () => CodingSupervision;
			changed: (db: Database, t: WorkTask) => void;
		}) => TasksService;
	} = {},
) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-supervision-")),
		path = join(dir, "db.sqlite3");
	const store = openStore(path, [
		tasksMigration,
		queueMigration,
		reportsMigration,
		settingsMigration,
		epochsMigration,
		inferenceMigration,
		parentsMigration,
		diagnosticsMigration,
		controlMigration,
		backgroundControlMigration,
		migration,
		...(options.migrations ?? []),
	]);
	let time = Date.now(),
		calls = 0;
	let next = proposal("wait"),
		lastMessages: unknown;
	const settings = await createSettings(store, { dbPath: path, env: {} });
	const larm: LarmPort = {
		status: () => ({ state: "ready", capabilities: ["llm"] }),
		connect: async () => {},
		answer: async (m, s) => {
			calls++;
			lastMessages = m;
			return options.model ? options.model(calls, s) : JSON.stringify(next);
		},
		transcribe: async () => new Promise(() => {}),
		speak: async () => new Promise(() => {}),
		close: async () => {},
	};
	const inference = createInference(store, settings, {
		larmFactory: () => larm,
		countControlTokens: () =>
			options.tokenCount === undefined ? 100 : options.tokenCount,
	});
	const queue = createQueue(store, {
		now: () => time,
		resources: { "inference.llm": 1 },
		resourceAliases: { "larm.llm": "inference.llm" },
	});
	let approve = options.approveInstructions ?? false;
	const steps: StepIntent[] = [];
	let observed = observation(),
		execute: (i: StepIntent, s: AbortSignal) => Promise<StepReceipt> = async (
			i,
		) => receipt(i);
	const workflow: WorkflowPort = {
		available: () => true,
		policy: () => ({
			checkIds: ["typecheck", "tests"],
			checksDigest: hash,
			reviewPolicyDigest: hash,
		}),
		observe: async () => observed,
		execute: async (i, s) => {
			steps.push(i);
			return execute(i, s);
		},
	};
	const tasks =
		options.tasksFactory?.({
			store,
			queue,
			workflow,
			now: () => time,
			supervision: () => supervision,
			changed: (db, t) => supervision?.taskChangedInTransaction(db, t),
		}) ??
		createTasks(store, {
			now: () => time,
			kinds: [
				{
					kind: "coding",
					version: 1,
					available: () => true,
					startInTransaction: () => {},
					stopInTransaction: () => {},
					answerInTransaction: () => {},
				},
			],
			changedInTransaction: (db, t) =>
				supervision?.taskChangedInTransaction(db, t),
		});
	const reports = createTaskReports({
		store,
		tasks: () => tasks,
		now: () => time,
	});
	const supervision = createCodingSupervision({
		store,
		tasks: () => tasks,
		queue,
		inference,
		reports,
		workflow,
		approveInstructions: () => approve,
		now: () => time,
	});
	const t = await tasks.create({
		requestId: crypto.randomUUID(),
		kind: "coding",
		version: 1,
		title: "fixture",
		request: "決められた検証とレビューを通して実装する",
		completionConditions: ["要件を満たす"],
		startMode: "start",
		grant: {
			workspaceId: "fixture",
			operations: options.operations ?? [
				"read",
				"edit",
				"check",
				"review",
				"commit",
				"push",
			],
			branch: "codex/task",
			remote: "origin",
			network: "registered",
			expiresAt: new Date(time + 7200000).toISOString(),
			maxDecisions: options.maxDecisions ?? 80,
		},
	});
	await store.write((db) =>
		tasks.applyTransitionInTransaction(
			db,
			fence(tasks.getInTransaction(db, t.taskId)!),
			{ state: "active", phase: "implementing", reason: "fixture_started" },
		),
	);
	clean.push(async () => {
		await queue.close(100);
		supervision.close();
		await inference.close();
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const observe = async (o = observed) => {
		observed = o;
		await store.write((db) =>
			supervision.observeInTransaction(db, t.taskId, o),
		);
	};
	async function drain() {
		for (let i = 0; i < 200; i++) {
			await queue.tick();
			await Bun.sleep(2);
			if (queue.stats().openJobs === 0) return;
		}
		throw new Error("fixture_queue_timeout");
	}
	return {
		store,
		queue,
		inference,
		settings,
		tasks,
		reports,
		supervision,
		workflow,
		taskId: t.taskId,
		steps,
		observe,
		drain,
		setApproveInstructions: (on: boolean) => {
			approve = on;
		},
		calls: () => calls,
		messages: () => lastMessages,
		decision: (d: Decision) => {
			next = d;
		},
		execute: (fn: typeof execute) => {
			execute = fn;
		},
		advance: (ms: number) => {
			time += ms;
		},
		now: () => time,
	};
}
