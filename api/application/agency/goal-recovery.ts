import type { Database } from "bun:sqlite";
import type {
	GoalAttempt,
	GoalProgress,
	GoalStore,
} from "eumenes-agency/agenda/runtime";
import { goalAccess } from "./goal-progress-context";
import type { GoalProgressPorts } from "./goal-progress";
import { goalHasParkedWork, goalTerminal, goalSlotBusy } from "./goal-receipts";

export const openJob = (state: string | undefined) =>
	state === "queued" || state === "running" || state === "retry_wait";
export const scheduled = (row: GoalProgress) =>
	!goalTerminal(row) &&
	((row.phase !== "waiting" && row.phase !== "needs_user") ||
		row.dueAtMs !== null);

export function createGoalRecovery(
	ports: GoalProgressPorts,
	ops: {
		advance(
			db: Database,
			row: GoalProgress,
			next: Parameters<GoalStore["transitionProgressInTransaction"]>[4],
		): GoalProgress | null;
		scopeAllowed(db: Database, row: GoalProgress): boolean;
		slotTurn(db: Database, row: GoalProgress): boolean;
		stopped(db: Database, row: GoalProgress): boolean;
		submit(db: Database, row: GoalProgress): void;
		wake(): void;
		now(): number;
		scope: string;
		deferReceipt(db: Database, row: GoalProgress, claimId: string): void;
		pendingParkedReceipt(db: Database, row: GoalProgress): GoalAttempt | null;
		recoverParked(db: Database, row: GoalProgress): void;
		resumeDesignFailure(db: Database, row: GoalProgress): boolean;
	},
) {
	const { store, goals, queue } = ports;
	const {
		advance,
		scopeAllowed,
		slotTurn,
		stopped,
		submit,
		wake,
		now,
		scope,
		deferReceipt,
		pendingParkedReceipt,
		recoverParked,
		resumeDesignFailure,
	} = ops;
	let unsubscribe: (() => void) | undefined;
	let stopConfiguration: (() => void) | undefined;
	let draining = false;
	function needsRecovery(db: Database, row: GoalProgress) {
		const active = goals.activeProgressInTransaction(db, goalAccess(row), row);
		const job = row.jobId ? queue.getInTransaction(db, row.jobId) : null;
		const receipt = row.currentWorkId || pendingParkedReceipt(db, row);
		if (!active && !goalTerminal(row)) return true;
		if (!active && !receipt) return openJob(job?.state);
		if (
			row.phase === "needs_user" &&
			row.currentWorkId !== null &&
			!stopped(db, row)
		)
			return false;
		if (
			row.state.problem === goalSlotBusy &&
			!stopped(db, row) &&
			goals.goalWorkSlotOpenInTransaction(db, row.principal) &&
			slotTurn(db, row) &&
			(row.dueAtMs ?? 0) > now()
		)
			return true;
		return (
			(receipt ||
				(ports.enabled(db) && scopeAllowed(db, row) && scheduled(row))) &&
			(row.needsEnqueue || !openJob(job?.state)) &&
			queue.hasCapacityInTransaction(db, scope, "background")
		);
	}
	const hasLegacy = (db: Database) =>
		!!ports.legacyAccess &&
		ports.enabled(db) &&
		goals.hasActivatableLegacyGoalsInTransaction(db, ports.legacyAccess);
	function recoverDelivery(db: Database, row: GoalProgress) {
		const source = row.state.sourceRef;
		if (
			!source ||
			row.deliveryConversationId !== null ||
			!scopeAllowed(db, row)
		)
			return;
		const conversation = ports.deliveryConversationOf?.(db, source);
		if (conversation)
			goals.recoverGoalDeliveryInTransaction(
				db,
				goalAccess(row),
				row,
				source,
				conversation,
			);
	}
	function recoverInTransaction(db: Database) {
		if (ports.legacyAccess && hasLegacy(db))
			for (const adopted of goals.activateLegacyGoalsInTransaction(
				db,
				ports.legacyAccess,
				now(),
				ports.sourceText,
			)) {
				recoverDelivery(db, adopted);
				submit(
					db,
					ports.reconcileConfiguration?.(db, adopted) ??
						ports.legacyReadPolicy?.(db, adopted) ??
						adopted,
				);
			}
		for (const row of goals.progressRowsInTransaction(db)) {
			if (!needsRecovery(db, row)) continue;
			const access = goalAccess(row);
			if (!goals.activeProgressInTransaction(db, access, row)) {
				const retired = goalTerminal(row)
					? row
					: goals.retireProgressInTransaction(db, access, row, "superseded");
				if (
					retired &&
					!retired.needsEnqueue &&
					(retired.currentWorkId || pendingParkedReceipt(db, retired))
				)
					deferReceipt(db, retired, "");
				else if (retired) submit(db, retired);
				continue;
			}
			if (
				row.state.problem === goalSlotBusy &&
				goals.goalWorkSlotOpenInTransaction(db, row.principal) &&
				slotTurn(db, row)
			)
				advance(db, row, (current) => ({
					phase: current.phase,
					dueAtMs: now(),
					state: current.state,
				}));
			else if (row.needsEnqueue) submit(db, row);
			else
				advance(db, row, (current) => ({
					phase:
						current.phase === "needs_user" && current.currentWorkId
							? "observing"
							: current.phase,
					dueAtMs:
						current.dueAtMs ??
						(pendingParkedReceipt(db, current) ? now() : null),
					state: current.state,
				}));
		}
	}
	async function recover() {
		await store.write((db) => {
			for (const row of goals.progressRowsInTransaction(db))
				recoverParked(db, row);
			configurationChangedInTransaction(db);
			recoverInTransaction(db);
		});
		wake();
	}
	function configurationChangedInTransaction(db: Database) {
		for (const row of goals.progressRowsInTransaction(db)) {
			if (!ports.enabled(db) && goalHasParkedWork(db, goals, row)) {
				advance(db, row, (current) => ({
					phase: current.phase,
					state: current.state,
					dueAtMs: now(),
				}));
				continue;
			}
			if (
				scopeAllowed(db, row) &&
				goals.activeProgressInTransaction(db, goalAccess(row), row)
			) {
				recoverDelivery(db, row);
				if (ports.reconcileConfiguration) {
					if (ports.enabled(db)) {
						const configured = ports.reconcileConfiguration(db, row);
						if (resumeDesignFailure(db, configured)) continue;
						if (configured.progressVersion !== row.progressVersion)
							submit(db, configured);
					}
					continue;
				}
				if (ports.enabled(db) && resumeDesignFailure(db, row)) continue;
			}
			if (
				row.phase !== "waiting" ||
				row.state.watch?.producer !== "goal-configuration" ||
				!goals.activeProgressInTransaction(db, goalAccess(row), row) ||
				!scopeAllowed(db, row)
			)
				continue;
			advance(db, row, (current) => ({
				phase: "ready",
				state: { ...current.state, watch: null, problem: null },
			}));
		}
	}
	const listen = () => {
		if (unsubscribe) return;
		stopConfiguration = ports.onConfigurationChange?.(() => {
			void store.write(configurationChangedInTransaction).then(wake, () => {});
		});
		unsubscribe = store.onCommit(() => {
			if (
				draining ||
				!store.read(
					(db) =>
						hasLegacy(db) ||
						goals
							.progressRowsInTransaction(db)
							.some((row) => needsRecovery(db, row)),
				)
			)
				return;
			draining = true;
			void store
				.write((db) => recoverInTransaction(db))
				.then(wake, () => {})
				.finally(() => {
					draining = false;
				});
		});
	};
	return {
		recover,
		listen,
		configurationChangedInTransaction,
		close() {
			unsubscribe?.();
			stopConfiguration?.();
			unsubscribe = undefined;
		},
	};
}
