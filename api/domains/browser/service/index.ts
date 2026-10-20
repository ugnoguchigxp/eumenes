import type { Database } from "bun:sqlite";
import { createHostResolver } from "../adapters/host-resolver";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { QueueService } from "../../queue";
import {
	type BrowserCompletion,
	CAPTURE_MS,
	LEASE_MS,
	LEASE_RENEW_MS,
	RETENTION_MS,
	TASK_MS,
} from "../contracts";
import type {
	BrowserDriver,
	CaptureFiles,
	ExecutablePicker,
	HostResolver,
	ImageEncoder,
} from "../contracts/ports";
import {
	activeConnection,
	capturesRevision,
	connectionCount,
	listCaptures,
	expireApprovals,
	listTasks,
	purgeEnded,
	tabsRevision,
	tasksRevision,
	taskRow,
	type TaskRow,
} from "../repository";
import { taskApi } from "./task-api";
import { createApprovals } from "./approvals";
import { createCaptures, type StartCaptureInput } from "./captures";
import { createSetting } from "./setting";
import { connectionView, createConnection } from "./connection";
import {
	createSerial,
	type Ctx,
	type Serial,
	type TaskApi,
	type TaskStepRunner,
} from "./context";
import { createGrants } from "./grants";
import { createOperations } from "./operations";
import { reconcileChecked, tabViews } from "./tabs";
import { createTasks, type StartTaskInput } from "./tasks";

export type { StartCaptureInput } from "./captures";
export type { StartTaskInput, StartedTask } from "./tasks";
export type { TaskApi, TaskStepRunner } from "./context";

export function createBrowser(deps: {
	store: SqliteStore;
	queue: QueueService;
	driver: BrowserDriver;
	encoder: ImageEncoder;
	files: CaptureFiles;
	/** Origins of the Eumenes web screen: the only private addresses a task may open (never under `/api`). */
	webOrigins: readonly string[];
	/** DNS for the destination check (a name resolving to a private address is private); the system resolver by default. */
	resolveHost?: HostResolver;
	/** A finished task or capture, reported into the conversation that asked for it. */
	announceInTransaction?: (db: Database, notice: BrowserCompletion) => void;
	/** One model step of a page-operation task (S2); without it tasks cannot be started. */
	runTaskStep?: TaskStepRunner;
	now?: () => number;
	leaseMs?: number;
	renewMs?: number;
	taskMs?: number;
	captureMs?: number;
	/** Where Brave is installed by default; the first executable one is offered while no path is saved. */
	standardPaths?: readonly string[];
	/** The OS file dialog for choosing Brave; without it the path is only typed in. */
	pickExecutable?: ExecutablePicker;
	canAutoConnect?: () => boolean;
	credentialRevision?: () => number;
}) {
	const { store } = deps;
	const serials = new Map<string, Serial>();
	const ctx: Ctx = {
		store,
		queue: deps.queue,
		driver: deps.driver,
		encoder: deps.encoder,
		files: deps.files,
		now: deps.now ?? Date.now,
		webOrigins: deps.webOrigins,
		announce: deps.announceInTransaction ?? (() => undefined),
		resolveHost: deps.resolveHost ?? createHostResolver(),
		dnsCache: new Map(),
		runTaskStep: deps.runTaskStep,
		canAutoConnect: deps.canAutoConnect ?? (() => false),
		credentialRevision: deps.credentialRevision ?? (() => 0),
		leaseMs: deps.leaseMs ?? LEASE_MS,
		renewMs: deps.renewMs ?? LEASE_RENEW_MS,
		taskMs: deps.taskMs ?? TASK_MS,
		captureMs: deps.captureMs ?? CAPTURE_MS,
		inflight: new Map(),
		serialOf(connectionId) {
			let s = serials.get(connectionId);
			if (!s) {
				for (const [id, old] of serials) if (!old.busy) serials.delete(id);
				s = createSerial();
				serials.set(connectionId, s);
			}
			return s;
		},
	};
	const connection = createConnection(ctx);
	const grants = createGrants(ctx);
	const approvals = createApprovals(ctx, grants);
	const operations = createOperations(ctx, grants, approvals);
	const captures = createCaptures(ctx);
	const tasks = createTasks(ctx, apiFor, approvals);
	void connection.ready
		.then(() => captures.removeOrphans())
		.catch(() => undefined);

	function startCapture(input: StartCaptureInput) {
		return store.write((db) => captures.startInTransaction(db, input));
	}
	function apiFor(task: TaskRow, signal: AbortSignal): TaskApi {
		return taskApi(ctx, task, signal, {
			connection,
			operations,
			grants,
			approvals,
			captures,
			refreshTabs,
		});
	}

	/** Re-lists the tabs unless a call sequence is running (the screen must not wait on a long operation). */
	async function refreshTabs() {
		await connection.ready;
		const active = store.read((db) =>
			connectionView(ctx, db).availability.available
				? activeConnection(db)
				: null,
		);
		if (active) {
			const serial = ctx.serialOf(active.id);
			if (!serial.busy)
				await serial
					.run(async () => {
						await reconcileChecked(ctx, active.id, await ctx.driver.listTabs());
					})
					.catch(() => undefined);
		}
		return store.read((db) => tabViews(ctx, db));
	}

	const ended = (aborts: { tasks: string[]; captures: string[] }) => {
		for (const id of aborts.tasks) tasks.abortRunning(id);
		for (const id of aborts.captures) captures.abortRunning(id);
	};

	const service = {
		setting: createSetting({
			store,
			now: ctx.now,
			standardPaths: deps.standardPaths,
			pickExecutable: deps.pickExecutable,
		}),
		ready: connection.ready,
		connection: () => store.read((db) => connectionView(ctx, db)),
		connect: connection.connect,
		disconnect: connection.disconnect,
		/** Resolves when a connection attempt in progress has finished. */
		settled: connection.settled,
		availability: () => service.connection().availability,
		availableInTransaction: (db: Database) =>
			connectionView(ctx, db).availability.available,
		tabs: () => store.read((db) => tabViews(ctx, db)),
		refreshTabs,
		/** Opens a new tab (the URL is checked like any navigation); the result carries its `tabRef`. */
		openTab: (
			owner: string,
			taskId: string | null,
			url: string,
			signal?: AbortSignal,
		) =>
			operations.operate(
				{ owner, taskId, action: { kind: "tab_new", url } },
				signal,
			),
		closeTab: (
			owner: string,
			taskId: string | null,
			tabRef: string,
			signal?: AbortSignal,
		) =>
			operations.operate(
				{ owner, taskId, tabRef, action: { kind: "tab_close" } },
				signal,
			),
		focusTab: (
			owner: string,
			taskId: string | null,
			tabRef: string,
			signal?: AbortSignal,
		) =>
			operations.operate(
				{ owner, taskId, tabRef, action: { kind: "tab_select" } },
				signal,
			),
		observe: operations.observe,
		/** One page operation (see `PageOperation`); the browser is changed only through this. */
		operate: operations.operate,
		grantFromRequest: (
			owner: string,
			taskId: string,
			input: Parameters<
				ReturnType<typeof createGrants>["fromRequestInTransaction"]
			>[3],
		) =>
			store.write((db) =>
				grants.fromRequestInTransaction(db, owner, taskId, input),
			),
		/** The user's own approval of a value the request did not contain. */
		grantUserApproved: (
			owner: string,
			taskId: string,
			input: Parameters<
				ReturnType<typeof createGrants>["userApprovedInTransaction"]
			>[3],
		) =>
			store.write((db) =>
				grants.userApprovedInTransaction(db, owner, taskId, input),
			),
		startTaskInTransaction: (db: Database, input: StartTaskInput) =>
			tasks.startInTransaction(db, input),
		startTask: (input: StartTaskInput) =>
			store.write((db) => tasks.startInTransaction(db, input)),
		cancelTaskInTransaction: tasks.cancelInTransaction,
		cancelTask: async (owner: string, id: string) => {
			const view = await store.write((db) =>
				tasks.cancelInTransaction(db, owner, id),
			);
			tasks.abortRunning(id);
			return view;
		},
		/** For callers that cancel inside their own transaction: abort the running step after it commits. */
		abortTask: tasks.abortRunning,
		taskStatus: (owner: string, id: string) =>
			store.read((db) => tasks.status(db, owner, id)),
		listTasks: (owner: string, conversationId?: string) =>
			store.read((db) => listTasks(db, owner, 20, conversationId)),
		/** The step the S2 worker's runner drives; exposed for tests of the hook. */
		taskRow: (id: string) => store.read((db) => taskRow(db, id)),
		startCaptureInTransaction: (db: Database, input: StartCaptureInput) =>
			captures.startInTransaction(db, input),
		startCapture,
		cancelCaptureInTransaction: captures.cancelInTransaction,
		cancelCapture: async (owner: string, id: string) => {
			const view = await store.write((db) =>
				captures.cancelInTransaction(db, owner, id),
			);
			captures.abortRunning(id);
			return view;
		},
		abortCapture: captures.abortRunning,
		captureStatus: (owner: string, id: string) =>
			store.read((db) => captures.status(db, owner, id)),
		listCaptures: (owner: string) =>
			store.read((db) => listCaptures(db, owner)),
		captureContent: captures.content,
		/**
		 * Ends tasks and captures past their deadline, expires old approvals, deletes what ended more than 7 days
		 * ago (tasks, operations, grants, approvals) and removes orphan capture files.
		 */
		async sweep() {
			await connection.ready;
			const result = await store.write((db) => {
				const ended = {
					tasks: tasks.expireDue(db),
					captures: captures.expireDue(db),
				};
				expireApprovals(db, ctx.now());
				purgeEnded(db, ctx.now() - RETENTION_MS);
				return ended;
			});
			ended(result);
			await captures.removeOrphans();
			return result;
		},
		sourceInTransaction(db: Database, owner: string) {
			const view = connectionView(ctx, db);
			const settings = db
				.query(
					"SELECT COUNT(*) AS n, COALESCE(MAX(updated_at),0) AS t FROM browser_settings",
				)
				.get() as { n: number; t: number };
			return {
				revision:
					connectionCount(db) +
					tabsRevision(db) +
					tasksRevision(db) +
					capturesRevision(db) +
					settings.n +
					settings.t,
				data: {
					availability: view.availability,
					connection: view,
					tabs: tabViews(ctx, db),
					tasks: listTasks(db, owner),
					captures: listCaptures(db, owner),
				},
			};
		},
	};
	return service;
}
export type BrowserService = ReturnType<typeof createBrowser>;
