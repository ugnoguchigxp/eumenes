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
} from "../contracts";
import {
	getNotification,
	getStartedReceiptByRun,
	getTimer,
	latestOpenNotification,
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
import { iso } from "./canonical";

export function createTimers(
	store: SqliteStore,
	ports: { scheduler: SchedulerService; queue: QueueService },
	options: {
		now?: () => number;
		id?: () => string;
		publish?: () => void;
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
		protectedIds: options.protectedIds,
		log,
	};
	const scope = options.scope ?? DEFAULT_TIMER_SCOPE;
	const expiry = createExpiry(deps);
	ports.scheduler.registerTarget(expiry.target);
	ports.queue.registerHandler(expiry.handler);
	const apiOrigin = (extra?: Partial<TimerOrigin>): TimerOrigin => ({
		scope,
		conversationId: null,
		runId: null,
		messageId: null,
		originKey: null,
		...extra,
		scope: extra?.scope ?? scope,
	});

	async function commit<T>(work: (tx: Database) => T, wake: boolean) {
		const result = await store.write(work);
		if (wake) {
			ports.scheduler.wake();
			ports.queue.wake();
			options.publish?.();
		}
		return result;
	}

	return {
		target: expiry.target,
		handler: expiry.handler,
		startInTransaction: (tx: Database, command: unknown, origin: TimerOrigin) =>
			startInTransaction(tx, deps, command, origin),
		listInTransaction: (tx: Database, query: ListTimersQuery, listScope = scope) =>
			listInTransaction(tx, deps, query, listScope),
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
		claimInTransaction: (tx: Database, id: string, command: unknown, listScope = scope) =>
			claimInTransaction(tx, deps, id, listScope, command),
		ackInTransaction: (tx: Database, id: string, command: unknown, listScope = scope) =>
			ackInTransaction(tx, deps, id, listScope, command),
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
					notification: note ? notificationDto(note) : null,
				};
			});
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
