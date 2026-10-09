import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { createTasks, migration as tasksMigration } from "../../tasks";
import { createTaskReports, migration } from "..";
import type { ReportBody } from "../contracts";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const c of cleanup.splice(0)) await c();
});
async function setup() {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-reports-")),
		store = openStore(join(dir, "db"), [tasksMigration, migration]),
		tasks = createTasks(store, {
			kinds: [
				{
					kind: "coding",
					version: 1,
					available: () => true,
					startInTransaction: () => {},
					stopInTransaction: () => {},
				},
			],
		}),
		reports = createTaskReports({ store, tasks: () => tasks });
	const t = await tasks.create(
		{
			requestId: crypto.randomUUID(),
			kind: "coding",
			version: 1,
			title: "reports",
			request: "report test",
			completionConditions: ["complete"],
			startMode: "register_only",
			grant: {
				workspaceId: "workspace",
				operations: ["read"],
				expiresAt: new Date(Date.now() + 3600000).toISOString(),
			},
		},
		{
			origin: {
				source: "conversation",
				conversationId: "c1",
				messageId: "m1",
				runId: null,
				operationKey: "op1",
			},
		},
	);
	cleanup.push(async () => {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	return { store, tasks, reports, id: t.taskId };
}
const body = (kind: ReportBody["kind"] = "progress"): ReportBody => ({
	kind,
	summary: "確認済みの進捗",
	facts: ["実行状態を確認"],
	limitations: [],
	evidenceRefs: ["evidence-1"],
	snapshotHash: null,
	questionId: null,
});
test("immutable report sequence and origin are deduplicated with a durable outbox", async () => {
	const h = await setup();
	const a = await h.store.write((db) =>
		h.reports.appendInTransaction(db, h.id, "event:1", body()),
	);
	expect(
		await h.store.write((db) =>
			h.reports.appendInTransaction(db, h.id, "event:1", body()),
		),
	).toEqual(a);
	await expect(
		h.store.write((db) =>
			h.reports.appendInTransaction(db, h.id, "event:1", {
				...body(),
				summary: "different",
			}),
		),
	).rejects.toThrow("task_report_conflict");
	await h.store.write((db) =>
		h.reports.appendInTransaction(db, h.id, "event:2", body()),
	);
	const page = h.reports.list(h.id, 0, 1);
	expect(page.items[0]?.originConversationId).toBe("c1");
	expect(page.nextCursor).toBe(1);
	expect(h.reports.list(h.id, page.nextCursor!).items[0]?.sequence).toBe(2);
	expect(
		h.store.read((db) =>
			db.query("SELECT state FROM task_report_outbox ORDER BY rowid").all(),
		),
	).toEqual([{ state: "superseded" }, { state: "pending" }]);
});
test("report and outbox roll back together, and contract size bounds are enforced", async () => {
	const h = await setup();
	await expect(
		h.store.write((db) => {
			h.reports.appendInTransaction(db, h.id, "rollback", body());
			throw new Error("rollback");
		}),
	).rejects.toThrow("rollback");
	expect(h.reports.list(h.id).items).toHaveLength(0);
	for (const bad of [
		{ ...body(), summary: "a".repeat(601) },
		{ ...body(), facts: Array(9).fill("fact") },
		{ ...body(), evidenceRefs: Array(21).fill("ref") },
	])
		await expect(
			h.store.write((db) =>
				h.reports.appendInTransaction(db, h.id, crypto.randomUUID(), bad),
			),
		).rejects.toThrow();
	expect(h.reports.list(h.id).items).toHaveLength(0);
});
test("resolved blocker outbox is superseded without mutating the report", async () => {
	const h = await setup();
	await h.tasks.start(h.id, {
		requestId: crypto.randomUUID(),
		expectedRevision: h.tasks.get(h.id).task.revision,
	});
	await h.store.write((db) => {
		const t = h.tasks.getInTransaction(db, h.id)!;
		h.tasks.applyTransitionInTransaction(
			db,
			{
				taskId: t.id,
				expectedRevision: t.revision,
				authorityEpoch: t.authorityEpoch,
				executionGeneration: t.executionGeneration,
			},
			{ state: "active", reason: "fixture_started" },
		);
		const active = h.tasks.getInTransaction(db, h.id)!;
		h.tasks.askInTransaction(
			db,
			{
				taskId: active.id,
				expectedRevision: active.revision,
				authorityEpoch: active.authorityEpoch,
				executionGeneration: active.executionGeneration,
			},
			{
				questionId: "question-1",
				prompt: "仕様の確認",
				answerType: "text",
				choices: [],
			},
		);
		h.reports.appendInTransaction(db, h.id, "blocker", {
			...body("blocker"),
			questionId: "question-1",
		});
	});
	await h.store.write((db) =>
		h.reports.supersedeQuestionsInTransaction(db, h.id),
	);
	const old = h.reports.list(h.id).items[0]!;
	expect(old.kind).toBe("blocker");
	const t = h.tasks.get(h.id).task;
	await h.tasks.stop(h.id, {
		requestId: crypto.randomUUID(),
		expectedRevision: t.revision,
		intent: "cancel",
	});
	expect(
		await h.store.write((db) =>
			h.reports.appendInTransaction(db, h.id, "blocker", {
				...body("blocker"),
				questionId: "question-1",
			}),
		),
	).toEqual(old);
	expect(
		h.store.read((db) =>
			db.query("SELECT state FROM task_report_outbox").get(),
		),
	).toEqual({ state: "superseded" });
});
