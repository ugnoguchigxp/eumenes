import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../infrastructure/sqlite";
import type { KanbanDispatch, KanbanRunFinish } from "./contracts";
import { deleteOldReceipts } from "./repository";
import { deleteOldRuns, handedRuns } from "./runs-repository";

/** What the run recovery reads of a terminals request (structural; no terminals import). */
export type KanbanRecoverPorts = {
	handles?: (executorId: string) => boolean;
	request(
		tx: Database,
		runId: string,
		executorId?: string,
	): {
		state: string;
		reason?: string;
		lastReport?: string;
		files: readonly string[];
	} | null;
	/** Hands a run over to terminals inside the recovery transaction. */
	enqueue(tx: Database, dispatch: KanbanDispatch): void;
};
type Request = ReturnType<KanbanRecoverPorts["request"]>;

const FINAL = new Set([
	"completed",
	"interrupted",
	"ended",
	"unknown",
	"cancelled",
]);

/** Final runs and receipts are kept this long. */
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Settling handed runs from their terminals requests (startup recovery and reconciliation) and
 * the retention of old runs and receipts.
 */
export function createRecovery(
	store: SqliteStore,
	finishRun: (
		tx: Database,
		finish: KanbanRunFinish,
	) => { dispatch?: KanbanDispatch } | null,
	now: () => number,
) {
	/** The terminals request of a handed run, when it reached a final state. */
	const finalRequest = (
		tx: Database,
		ports: Pick<KanbanRecoverPorts, "request">,
		runId: string,
		executorId: string,
	) => {
		const request = ports.request(tx, runId, executorId);
		return request && FINAL.has(request.state) ? request : null;
	};

	/** Settles a handed run from its final request (or as lost, when `request` is null). */
	function settleHanded(
		tx: Database,
		ports: KanbanRecoverPorts,
		runId: string,
		request: Request,
	) {
		const out = finishRun(
			tx,
			request
				? {
						runId,
						state: request.state as KanbanRunFinish["state"],
						reason: request.reason,
						lastReport: request.lastReport ?? "",
						files: request.files,
					}
				: {
						runId,
						state: "unknown",
						reason: "restarted",
						lastReport: "",
						files: [],
					},
		);
		if (out?.dispatch) ports.enqueue(tx, out.dispatch);
	}

	/** Deletes final runs and receipts older than the keep time (a card's current run stays). */
	function pruneInTransaction(tx: Database, at: number) {
		const before = at - KEEP_MS;
		return {
			runs: deleteOldRuns(tx, before),
			receipts: deleteOldReceipts(tx, before),
		};
	}

	return {
		/**
		 * Startup: runs that were handed over are settled from their terminals requests (a request
		 * that is gone, or that terminals recovery already ended, blocks the run and stops the queue).
		 */
		recover: (ports: KanbanRecoverPorts) =>
			store.write((tx) => {
				for (const run of handedRuns(tx)) {
					if (ports.handles && !ports.handles(run.executorId)) continue;
					const request = ports.request(tx, run.id, run.executorId);
					if (request && !FINAL.has(request.state)) continue;
					settleHanded(tx, ports, run.id, request);
				}
			}),

		/**
		 * Settles every handed run whose terminals request is already final: the card follows the
		 * request even when the transaction that ended the request could not write the card (the
		 * run would otherwise stay handed and block the queue). A run without a request is left
		 * alone here (only the startup recovery treats that as lost). Returns how many runs were
		 * settled. Called inside a transaction that has not committed yet, a snapshot cannot see
		 * its writes: `always` goes straight to the writer, which runs after that transaction.
		 */
		async reconcile(
			ports: KanbanRecoverPorts,
			check: { always?: boolean } = {},
		): Promise<number> {
			const stuck =
				check.always ||
				store.readSnapshot((tx) =>
					handedRuns(tx).some(
						(run) =>
							(!ports.handles || ports.handles(run.executorId)) &&
							finalRequest(tx, ports, run.id, run.executorId),
					),
				);
			if (!stuck) return 0;
			return store.write((tx) => {
				let settled = 0;
				for (const run of handedRuns(tx)) {
					if (ports.handles && !ports.handles(run.executorId)) continue;
					const request = finalRequest(tx, ports, run.id, run.executorId);
					if (!request) continue;
					settleHanded(tx, ports, run.id, request);
					settled++;
				}
				return settled;
			});
		},

		pruneInTransaction,

		/** Retention with the service clock; the host calls it now and then. */
		prune: () => store.write((tx) => pruneInTransaction(tx, now())),
	};
}
