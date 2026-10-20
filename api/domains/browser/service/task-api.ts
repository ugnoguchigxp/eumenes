import { captureStart, type TabView, type TaskPhase } from "../contracts";
import { taskRow, patchTask, type TaskRow } from "../repository";
import { bindingOf, checkScript, publishScript } from "./script";
import { connectionView, type createConnection } from "./connection";
import type { createOperations } from "./operations";
import type { createGrants } from "./grants";
import type { createApprovals } from "./approvals";
import type { createCaptures } from "./captures";
import type { Ctx, TaskApi } from "./context";
import type { Database } from "bun:sqlite";
import type { CaptureView } from "../contracts";
/** The task-bound API: saved Script cursor, active epoch and existing operation guards. */
export function taskApi(
	ctx: Ctx,
	task: TaskRow,
	signal: AbortSignal,
	deps: {
		connection: Pick<
			ReturnType<typeof createConnection>,
			"connect" | "settled"
		>;
		operations: ReturnType<typeof createOperations>;
		grants: ReturnType<typeof createGrants>;
		approvals: ReturnType<typeof createApprovals>;
		captures: ReturnType<typeof createCaptures>;
		refreshTabs: () => Promise<TabView[]>;
	},
): TaskApi {
	const { store } = ctx;
	const { connection, operations, grants, approvals, captures, refreshTabs } =
		deps;
	const startCapture = (
		input: Parameters<typeof captures.startInTransaction>[1],
	) => store.write((db) => captures.startInTransaction(db, input));
	const owner = task.owner;
	const binding = bindingOf(task);
	const currentTask = (db: Database) => {
		const current = taskRow(db, task.id);
		if (
			!current ||
			current.state !== "running" ||
			current.epoch !== task.epoch ||
			current.deadline <= ctx.now()
		)
			throw new Error("task_not_active");
		return current;
	};
	const assertActive = (db: Database) => checkScript(currentTask(db), binding);
	const progress = (phase: TaskPhase) =>
		store.write((db) => {
			const current = currentTask(db);
			if (current.phase !== phase) patchTask(db, task.id, { phase }, ctx.now());
		});
	return {
		progress,
		connection: () => store.read((db) => connectionView(ctx, db)),
		connect: async () => {
			await store.write((db) => assertActive(db));
			await progress("connecting");
			if (!ctx.canAutoConnect())
				throw new Error("browser_manual_connection_required");
			signal.throwIfAborted();
			if (ctx.driver.state().state === "disconnected")
				await connection.connect((db) => {
					signal.throwIfAborted();
					assertActive(db);
				});
			await connection.settled();
			signal.throwIfAborted();
			await store.write((db) => assertActive(db));
			return store.read((db) => connectionView(ctx, db));
		},
		publishScript: (input) =>
			store.write((db) =>
				publishScript(ctx, db, owner, task.id, task.epoch, input),
			),
		tabs: () => refreshTabs(),
		observe: async (tabRef) => {
			await progress("observing");
			return operations.observe({ owner, taskId: task.id, tabRef }, signal);
		},
		operate: async (tabRef, action) => {
			await progress("operating");
			return operations.operate(
				{ owner, taskId: task.id, tabRef, action, scriptBinding: binding },
				signal,
			);
		},
		grantFromRequest: (input) =>
			store.write((db) =>
				grants.fromRequestInTransaction(db, owner, task.id, input),
			),
		approvals: () => store.read((db) => approvals.approved(db, task.id)),
		capture: async (input): Promise<CaptureView> => {
			await progress("capturing");
			await store.write((db) => assertActive(db));
			return startCapture({
				...captureStart.parse({
					...input,
					requestId: input.requestId ?? crypto.randomUUID(),
				}),
				owner,
				conversationId: task.conversation_id,
				origin: "conversation",
				taskId: task.id,
				scriptBinding: binding,
			});
		},
		captureStatus: (captureId) => {
			const view = store.read((db) => captures.status(db, owner, captureId));
			if (view.taskId !== task.id) throw new Error("browser_capture_not_found");
			return view;
		},
	};
}
