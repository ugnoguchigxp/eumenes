import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import { getLogger } from "../../../infrastructure/logger";
import type { QueueService } from "../../queue";
import type { SchedulerService } from "../../scheduler";
import {
	DEFAULT_TIMER_SCOPE,
	type CancelTimerInput,
	type ListTimersQuery,
	type StartTimerInput,
	type TimerOrigin,
	timerReceiptSchema,
} from "../contracts";
import {
	getNotification,
	getOperation,
	getStartedReceiptByRun,
	getTimer,
	latestOpenNotification,
	recentNotifiedTimers,
} from "../repository";
import type { TimerDeps } from "./deps";
import { toDto } from "./dto";
import { createExpiry, notificationDto } from "./expiry";
import { maintenanceInTransaction } from "./maintenance";
import {
	ackInTransaction,
	claimInTransaction,
	listNotificationsInTransaction,
	silenceInTransaction,
} from "./notifications";
import {
	cancelInTransaction,
	getInTransaction,
	listInTransaction,
	recordListOperationInTransaction,
	startInTransaction,
} from "./operations";
import { iso, digest } from "./canonical";

export function createTimers(
	store: SqliteStore,
	ports: { scheduler: SchedulerService; queue: QueueService },
	options: {
		now?: () => number;
		id?: () => string;
		publish?: () => void;
		onElapsedInTransaction?: TimerDeps["onElapsedInTransaction"];
		protectedIds?: (tx: Database) => readonly string[];
		scope?: string;
	} = {},
) {
	const log = getLogger("timers");
	const deps: TimerDeps = {
		now: options.now ?? Date.now,
		id: options.id ?? (() => crypto.randomUUID()),
		scheduler: ports.scheduler,
		queue: ports.queue,
		publish: options.publish,
		onElapsedInTransaction: options.onElapsedInTransaction,
		protectedIds: options.protectedIds,
		log,
	};
	const scope = options.scope ?? DEFAULT_TIMER_SCOPE;
	const expiry = createExpiry(deps);
	ports.scheduler.registerTarget(expiry.target);
	ports.queue.registerHandler(expiry.handler);
	const apiOrigin = (extra?: Partial<TimerOrigin>): TimerOrigin => ({
		conversationId: null,
		runId: null,
		messageId: null,
		originKey: null,
		...extra,
		scope: extra?.scope ?? scope,
	});

	async function commit<T>(work: (tx: Database) => T, wake: boolean) {
		const { result, changed } = await store.write((tx) => {
			const before = (
				tx.query("SELECT total_changes() AS n").get() as { n: number }
			).n;
			const result = work(tx);
			return {
				result,
				changed:
					(tx.query("SELECT total_changes() AS n").get() as { n: number }).n !==
					before,
			};
		});
		if (wake && changed) {
			ports.scheduler.wake();
			ports.queue.wake();
			options.publish?.();
		}
		return result;
	}

	return {
		target: expiry.target,
		handler: expiry.handler,
		routeSnapshotInTransaction(tx: Database) {
			const at = deps.now();
			const active = listInTransaction(
				tx,
				deps,
				{ state: "active", limit: 100 },
				scope,
			);
			return {
				serverNow: iso(at),
				items: [
					...active.items,
					...recentNotifiedTimers(tx, scope, 8).map((row) => toDto(row, at)),
				].map(({ id, revision, state, label, remainingSeconds }) => ({
					id,
					revision,
					state,
					label,
					remainingSeconds,
				})),
			};
		},
		startInTransaction: (tx: Database, command: unknown, origin: TimerOrigin) =>
			startInTransaction(tx, deps, command, origin),
		listInTransaction: (
			tx: Database,
			query: ListTimersQuery,
			listScope = scope,
		) => listInTransaction(tx, deps, query, listScope),
		recordListOperationInTransaction: (
			tx: Database,
			command: {
				requestId: string;
				issuedAt: string;
				timerId?: string;
				state?: ListTimersQuery["state"];
			},
			listScope = scope,
		) => recordListOperationInTransaction(tx, deps, command, listScope),
		cancelInTransaction: (
			tx: Database,
			command: unknown,
			listScope: string,
			timerId: string,
		) => cancelInTransaction(tx, deps, command, listScope, timerId),
		getInTransaction: (tx: Database, timerId: string, listScope = scope) =>
			getInTransaction(tx, timerId, listScope, deps.now()),
		maintenanceInTransaction: (tx: Database) =>
			maintenanceInTransaction(tx, deps),
		claimInTransaction: (
			tx: Database,
			id: string,
			command: unknown,
			listScope = scope,
		) => claimInTransaction(tx, deps, id, listScope, command),
		ackInTransaction: (
			tx: Database,
			id: string,
			command: unknown,
			listScope = scope,
		) => ackInTransaction(tx, deps, id, listScope, command),
		silenceInTransaction: (
			tx: Database,
			id: string,
			command: unknown,
			listScope = scope,
		) => silenceInTransaction(tx, deps, id, listScope, command),
		async start(input: StartTimerInput, origin?: Partial<TimerOrigin>) {
			return commit(
				(tx) => startInTransaction(tx, deps, input, apiOrigin(origin)),
				true,
			);
		},
		list(query: ListTimersQuery = {}) {
			return store.read((tx) => listInTransaction(tx, deps, query, scope));
		},
		get(timerId: string) {
			return store.read((tx) => {
				const at = deps.now();
				const timer = getInTransaction(tx, timerId, scope, at);
				if (!timer) return null;
				const note = latestOpenNotification(tx, timerId);
				return {
					serverNow: iso(at),
					timer,
					notification: note ? notificationDto(note, tx) : null,
				};
			});
		},
		readReceiptInTransaction(db: Database, operationId: string) {
			const row = getOperation(db, operationId);
			if (!row || row.scope !== scope || !row.receiptJson) return null;
			const receipt = timerReceiptSchema.parse(JSON.parse(row.receiptJson));
			if (
				digest(receipt) !== row.receiptDigest ||
				receipt.operationId !== row.id
			)
				throw new Error("action_invalidated");
			return { operationId: row.id, receiptDigest: row.receiptDigest, receipt };
		},
		projectReceiptInTransaction(db: Database, operationId: string) {
			const row = getOperation(db, operationId);
			if (!row || row.scope !== scope || !row.receiptJson)
				throw new Error("operation_expired");
			const receipt = timerReceiptSchema.parse(JSON.parse(row.receiptJson));
			if (
				digest(receipt) !== row.receiptDigest ||
				receipt.operationId !== row.id
			)
				throw new Error("action_invalidated");
			const at = deps.now();
			if (receipt.action === "listed")
				return {
					...receipt,
					serverNow: iso(at),
					items: receipt.items.flatMap((saved) => {
						const current = getInTransaction(db, saved.id, scope, at);
						return current &&
							!current.bodyExpired &&
							(row.timerId || current.state === saved.state)
							? [current]
							: [];
					}),
				};
			const current = getInTransaction(db, receipt.timer.id, scope, at);
			if (!current || current.bodyExpired) throw new Error("operation_expired");
			return { ...receipt, timer: current, serverNow: iso(at) };
		},
		receiptByRun(runId: string, listScope = scope) {
			return store.read((tx) => {
				const row = getStartedReceiptByRun(tx, listScope, runId);
				return {
					serverNow: iso(deps.now()),
					receipt: row?.receiptJson
						? (JSON.parse(row.receiptJson) as ReturnType<
								typeof startInTransaction
							>["receipt"])
						: null,
				};
			});
		},
		async cancel(timerId: string, input: CancelTimerInput) {
			return commit(
				(tx) => cancelInTransaction(tx, deps, input, scope, timerId),
				true,
			);
		},
		notifications(query: { cursor?: string; limit?: number } = {}) {
			return store.read((tx) =>
				listNotificationsInTransaction(
					tx,
					deps,
					scope,
					query.cursor,
					query.limit,
				),
			);
		},
		claim: (id: string, input: unknown) =>
			commit((tx) => claimInTransaction(tx, deps, id, scope, input), true),
		ack: (id: string, input: unknown) =>
			commit((tx) => ackInTransaction(tx, deps, id, scope, input), true),
		silence: (id: string, input: unknown) =>
			commit((tx) => silenceInTransaction(tx, deps, id, scope, input), true),
		async maintenance() {
			return commit((tx) => maintenanceInTransaction(tx, deps), true);
		},
		async recover() {
			return commit((tx) => maintenanceInTransaction(tx, deps), true);
		},
		readTimer: (tx: Database, id: string) => getTimer(tx, id),
		readNotification: (tx: Database, id: string) => getNotification(tx, id),
		toDto,
	};
}

export type TimersService = ReturnType<typeof createTimers>;
