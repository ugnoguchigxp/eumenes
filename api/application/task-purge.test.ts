import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type SqliteStore } from "../infrastructure/sqlite";
import { createTaskReports } from "../domains/task-reports";
import { createTasks } from "../domains/tasks";
import { createTaskSchema } from "../domains/tasks/contracts";
import { purgeTaskDependents } from "./coding-supervision";
import { migrations } from "./migrations";

const stores: SqliteStore[] = [],
	dirs: string[] = [];
afterEach(async () => {
	for (const store of stores.splice(0)) await store.close();
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
const DAY = 86_400_000;

test("purging a finished task removes report and supervision rows with no coding runner configured", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-task-purge-"));
	dirs.push(dir);
	const store = openStore(join(dir, "db"), migrations);
	stores.push(store);
	const clock = { t: Date.parse("2026-10-09T00:00:00Z") };
	const kind = {
		kind: "coding" as const,
		version: 1 as const,
		available: () => true,
		startInTransaction() {},
		stopInTransaction() {},
	};
	const setup = createTasks(store, { now: () => clock.t, kinds: [kind] });
	const { taskId } = await setup.create(
		createTaskSchema.parse({
			requestId: crypto.randomUUID(),
			kind: "coding",
			version: 1,
			title: "fixture task",
			request: "implement the requested change",
			completionConditions: ["checks pass"],
			startMode: "start",
			grant: {
				workspaceId: "fixture-workspace",
				operations: ["read"],
				expiresAt: new Date(clock.t + 365 * DAY).toISOString(),
			},
		}),
	);
	const fence = () => {
		const t = setup.get(taskId).task;
		return {
			taskId,
			expectedRevision: t.revision,
			authorityEpoch: t.authorityEpoch,
			executionGeneration: t.executionGeneration,
		};
	};
	await store.write((tx) =>
		setup.applyTransitionInTransaction(tx, fence(), {
			state: "active",
			phase: "implementing",
			reason: "fixture_started",
		}),
	);
	await store.write((tx) =>
		setup.applyTransitionInTransaction(tx, fence(), {
			state: "completed",
			phase: "finalizing",
			reason: "finished",
			result: {
				summary: "done",
				evidenceRefs: ["receipt:checks"],
				conditionsMet: [true],
			},
		}),
	);
	await store.write((tx) =>
		tx.exec(`INSERT INTO task_reports VALUES('r1','${taskId}',1,'k','{}');
INSERT INTO task_report_outbox VALUES('r1','${taskId}','progress','pending');
INSERT INTO coding_supervisors VALUES('${taskId}','{}');
INSERT INTO coding_observations VALUES('o1','${taskId}','f',1,'{}');
INSERT INTO coding_decisions VALUES('d1','${taskId}','open','{}');
INSERT INTO coding_steps VALUES('s1','${taskId}','open','{}');
INSERT INTO coding_supervision_budgets VALUES('${taskId}',0,0,'[]');`),
	);
	// Same composition as the server without codingRunnerConfig: no supervision, no kinds.
	const reports = createTaskReports({ store, tasks: () => tasks });
	const tasks = createTasks(store, {
		now: () => clock.t,
		purgeInTransaction: purgeTaskDependents(reports),
	});
	clock.t += 31 * DAY;
	await tasks.maintenance();
	clock.t += 90 * DAY;
	await tasks.maintenance();
	const n = (table: string) =>
		(
			store.read((db) =>
				db.query(`SELECT count(*) AS n FROM ${table}`).get(),
			) as { n: number }
		).n;
	for (const table of [
		"work_tasks",
		"task_reports",
		"task_report_outbox",
		"coding_supervisors",
		"coding_observations",
		"coding_decisions",
		"coding_steps",
		"coding_supervision_budgets",
	])
		expect(n(table)).toBe(0);
});
