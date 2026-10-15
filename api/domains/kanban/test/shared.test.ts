import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
	createKanban,
	migrations,
	reserveWorkspaceInTransaction,
	beginWorkspaceReleaseInTransaction,
	finishWorkspaceReleaseInTransaction,
	readWorkspaceGuard,
	type KanbanExecutor,
} from "..";
import { LEGACY_EXECUTOR } from "../shared-contracts";
import { openKanban } from "./kanban.fixture";

const executors: KanbanExecutor[] = [
	LEGACY_EXECUTOR,
	...["codex", "grok-fixture"].map((id) => ({
		id,
		label: id,
		revision: 1,
		available: true,
		workspaceRef: `workspace-${id}`,
		sessionPolicy: "executor-created" as const,
		capabilities: {
			terminal: false,
			activity: true,
			commit: false,
			push: false,
			commitPush: false,
		},
	})),
];
function fixture() {
	const { store } = openKanban();
	const service = createKanban({ store, executors: () => executors });
	let request = 0;
	const add = async (executorId: string, title: string) =>
		(
			await store.write((tx) =>
				service.addInTransaction(
					tx,
					{ executorId, title, prompt: title },
					`add-${++request}`,
				),
			)
		).receipt;
	const run = (cardId: string) =>
		store.write((tx) =>
			service.runInTransaction(
				tx,
				{
					cardId,
					expectedRevision: service.cardInTransaction(tx, cardId, {
						runnable: true,
					})!.revision,
				},
				`run-${++request}`,
				{ origin: "board", runnable: true },
			),
		);
	const board = () =>
		store.readSnapshot((tx) =>
			service.sharedBoardInTransaction(tx, { runnable: true }),
		);
	return { store, service, add, run, board };
}

test("registry-driven queues are independent, FIFO and admit a third executor without a provider branch", async () => {
	const h = fixture();
	const ca = await h.add("claude-code", "Claude A");
	const cb = await h.add("claude-code", "Claude B");
	const xa = await h.add("codex", "Codex A");
	const xb = await h.add("codex", "Codex B");
	const ga = await h.add("grok-fixture", "Third A");
	const first = await h.run(ca.cardId);
	expect((await h.run(cb.cardId)).dispatch).toBeUndefined();
	expect((await h.run(xa.cardId)).dispatch?.executorId).toBe("codex");
	expect((await h.run(xb.cardId)).dispatch).toBeUndefined();
	expect((await h.run(ga.cardId)).dispatch?.executorId).toBe("grok-fixture");
	expect(h.board().runs.map((run) => run.state)).toEqual([
		"dispatched",
		"queued",
		"dispatched",
		"queued",
		"dispatched",
	]);
	await h.store.write((tx) =>
		h.service.pauseQueueInTransaction(tx, "tracking_lost", "codex"),
	);
	const next = await h.store.write((tx) =>
		h.service.finishRunInTransaction(tx, {
			runId: first.receipt.runId!,
			state: "completed",
			lastReport: "verified",
			files: [],
		}),
	);
	expect(next?.dispatch?.cardId).toBe(cb.cardId);
	expect(h.board().queues.map((queue) => queue.state)).toEqual([
		"running",
		"paused",
		"running",
	]);
});

test("structured progress preserves executor/attempt/session identity and never adopts an old attempt", async () => {
	const h = fixture();
	const card = await h.add("codex", "work");
	const run = await h.run(card.cardId);
	const observation = {
		runId: run.receipt.runId!,
		executorId: "codex",
		executorRevision: 1,
		attemptRef: "attempt-1",
		state: "running" as const,
		sessionRef: "native-thread",
		executionStopped: false,
	};
	expect(
		await h.store.write((tx) =>
			h.service.observeExecutionInTransaction(tx, observation),
		),
	).toBe(true);
	expect(h.board().runs[0]).toMatchObject({
		state: "running",
		sessionRef: "native-thread",
		executionStopped: false,
	});
	expect(h.board().cards[0]!.actions).not.toContain("open");
	expect(
		await h.store.write((tx) =>
			h.service.observeExecutionInTransaction(tx, {
				...observation,
				attemptRef: "stale",
			}),
		),
	).toBe(false);
	expect(
		await h.store.write((tx) =>
			h.service.observeExecutionInTransaction(tx, {
				...observation,
				executorId: "grok-fixture",
			}),
		),
	).toBe(false);
	await expect(
		h.store.write((tx) =>
			h.service.observeExecutionInTransaction(tx, {
				...observation,
				state: "completed",
			}),
		),
	).rejects.toThrow("kanban_execution_stop_unconfirmed");
	expect(h.board().runs[0]!.state).toBe("running");
});

test("workspace reservation and executor enqueue rollback together; release reserves against new input", async () => {
	const h = fixture();
	const guard = {
		workspaceRef: "canonical-cwd",
		ownerRef: "card",
		executorId: "codex",
		epoch: "epoch-1",
		state: "held" as const,
	};
	await expect(
		h.store.write((tx) => {
			expect(reserveWorkspaceInTransaction(tx, guard)).toBe(true);
			throw new Error("executor_enqueue_failed");
		}),
	).rejects.toThrow("executor_enqueue_failed");
	expect(
		h.store.readSnapshot((tx) => readWorkspaceGuard(tx, guard.workspaceRef)),
	).toBeNull();
	await h.store.write((tx) => {
		expect(reserveWorkspaceInTransaction(tx, guard)).toBe(true);
		expect(
			reserveWorkspaceInTransaction(tx, {
				...guard,
				executorId: "claude-code",
				ownerRef: "other",
			}),
		).toBe(false);
		expect(beginWorkspaceReleaseInTransaction(tx, guard)).toBe(true);
		expect(reserveWorkspaceInTransaction(tx, guard)).toBe(false);
		expect(
			finishWorkspaceReleaseInTransaction(
				tx,
				{ ...guard, epoch: "stale" },
				true,
			),
		).toBe(false);
		expect(finishWorkspaceReleaseInTransaction(tx, guard, false)).toBe(false);
	});
	expect(
		h.store.readSnapshot((tx) => readWorkspaceGuard(tx, guard.workspaceRef))
			?.state,
	).toBe("unknown");
});

test("busy workspace defers the same run; executor changes require revision and no execution history", async () => {
	const h = fixture();
	const card = await h.add("codex", "work");
	await h.store.write((tx) =>
		h.service.selectExecutorInTransaction(
			tx,
			{ cardId: card.cardId, expectedRevision: 1, executorId: "grok-fixture" },
			"select",
		),
	);
	expect(h.board().cards[0]!.executorId).toBe("grok-fixture");
	const run = await h.run(card.cardId);
	await h.store.write((tx) =>
		h.service.deferDispatchInTransaction(tx, run.receipt.runId!),
	);
	expect(h.board().runs[0]!.state).toBe("queued");
	await expect(
		h.store.write((tx) =>
			h.service.selectExecutorInTransaction(
				tx,
				{ cardId: card.cardId, expectedRevision: 3, executorId: "codex" },
				"changed",
			),
		),
	).rejects.toThrow("kanban_handoff_required");
});

test("migration preserves Claude identifiers, FIFO, paused reason and immutable request receipts", () => {
	const db = new Database(":memory:");
	try {
		db.exec(migrations[0]!.sql);
		db.exec(migrations[1]!.sql);
		db.query(
			"INSERT INTO kanban_cards(id,revision,title,prompt,column_name,project_id,position,created_at,updated_at,claude_session_id,current_run_id) VALUES('card',4,'title','prompt','running','eumenes',0,1,2,'native-session','run')",
		).run();
		db.query(
			"INSERT INTO kanban_runs(id,card_id,kind,state,card_revision,title,prompt,body,claude_session_id,project_id,origin,created_at,handed_at) VALUES('run','card','task','handed',3,'title','prompt','body','native-session','eumenes','board',1,2)",
		).run();
		const bytes =
			'{"action":"added","cardId":"card","revision":1,"title":"title","column":"todo"}';
		db.query(
			"INSERT INTO kanban_receipts VALUES('request','add','digest',?,1)",
		).run(bytes);
		db.exec(
			"UPDATE kanban_board SET queue_state='paused',queue_reason='restarted';",
		);
		db.exec(migrations[2]!.sql);
		expect(
			db
				.query(
					"SELECT executor_id,session_ref,current_run_id,revision FROM kanban_cards",
				)
				.get(),
		).toEqual({
			executor_id: "claude-code",
			session_ref: "native-session",
			current_run_id: "run",
			revision: 4,
		});
		expect(
			db
				.query(
					"SELECT seq,state,session_ref,execution_stopped FROM kanban_runs",
				)
				.get(),
		).toEqual({
			seq: 1,
			state: "dispatched",
			session_ref: "native-session",
			execution_stopped: 0,
		});
		expect(db.query("SELECT state,reason FROM kanban_queues").get()).toEqual({
			state: "paused",
			reason: "restarted",
		});
		expect(
			db.query("SELECT receipt_json AS bytes FROM kanban_receipts").get(),
		).toEqual({ bytes });
	} finally {
		db.close();
	}
});

test("unknown execution pauses only its own queue, holds its guard, and cannot accept a late success", async () => {
	const h = fixture();
	const card = await h.add("codex", "unknown work");
	const later = await h.add("codex", "later work");
	const other = await h.add("grok-fixture", "other work");
	const run = await h.run(card.cardId);
	await h.run(later.cardId);
	const observation = {
		runId: run.receipt.runId!,
		executorId: "codex",
		executorRevision: 1,
		attemptRef: "unknown-attempt",
		state: "unknown" as const,
		executionStopped: false,
	};
	await h.store.write((tx) => {
		reserveWorkspaceInTransaction(tx, {
			workspaceRef: "workspace-codex",
			ownerRef: card.cardId,
			executorId: "codex",
			epoch: "runner-epoch",
			state: "held",
		});
		expect(
			h.service.finishExecutionInTransaction(tx, observation)?.dispatch,
		).toBeUndefined();
	});
	expect(h.board().runs[0]).toMatchObject({
		state: "unknown",
		executionStopped: false,
	});
	expect(h.board().queues[1]).toMatchObject({ state: "paused", waiting: 1 });
	expect((await h.run(other.cardId)).dispatch?.executorId).toBe("grok-fixture");
	expect(
		await h.store.write((tx) =>
			h.service.finishExecutionInTransaction(tx, {
				...observation,
				state: "completed",
				executionStopped: true,
				report: { summary: "late", files: [] },
			}),
		),
	).toBeNull();
	expect(h.board().cards.find((entry) => entry.id === card.cardId)!.label).toBe(
		"blocker",
	);
	expect(
		h.store.readSnapshot((tx) => readWorkspaceGuard(tx, "workspace-codex")),
	).not.toBeNull();
});
