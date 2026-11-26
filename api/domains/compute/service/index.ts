import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import { createCommands } from "./commands";
import type { QueueService } from "../../queue";
import {
	activeStates,
	submitInput,
	type ComputePort,
	type JobView,
} from "../contracts";
import {
	commandRow,
	list,
	owned,
	patch,
	row,
	savedEnvironment,
	view,
	type JobRow,
} from "../repository";
import { registerHandlers, type Step } from "./handlers";
import { createEnvironmentDiscovery } from "./environment";

export function createCompute(deps: {
	store: SqliteStore;
	queue: QueueService;
	port: () => ComputePort | null;
	pollMs?: number;
	validInTransaction?: (db: Database, row: JobRow) => boolean;
	onFinished?: (db: Database, job: JobView, conversationId: string) => void;
}) {
	const { store, queue } = deps;
	function enqueue(db: Database, id: string, operation: Step, delay = 0) {
		const r = row(db, id)!;
		const step = r.step + 1;
		patch(db, id, { step });
		queue.enqueueInTransaction(db, {
			scope: "compute",
			kind: "compute.advance",
			dedupeKey: `${id}:${step}`,
			payload: { id, step, operation },
			subjectRef: id,
			lane: "interactive",
			concurrencyKey: `compute:${id}`,
			availableAtMs: Date.now() + delay,
			maxAttempts: 1,
		});
	}
	function notify(db: Database, r: JobRow) {
		if (
			Date.now() >= r.deadline ||
			deps.validInTransaction?.(db, r) === false
		) {
			patch(db, r.id, { invalidated: 1 });
			return;
		}
		if (r.announced || r.invalidated || r.origin !== "conversation") return;
		patch(db, r.id, { announced: 1 });
		deps.onFinished?.(db, view(db, r), r.conversation_id);
	}
	registerHandlers({ ...deps, enqueue, notify, pollMs: deps.pollMs ?? 1000 });
	function cancelInTransaction(
		db: Database,
		owner: string,
		id: string,
		invalidate = false,
	) {
		const r = owned(db, owner, id);
		if (!activeStates.includes(r.state) && r.state !== "indeterminate")
			return view(db, r);
		patch(db, id, {
			cancel_requested: 1,
			...(invalidate ? { invalidated: 1 } : {}),
			cancel_until: Date.now() + 30000,
		});
		if (!r.sent) patch(db, id, { state: "cancelled", step: r.step + 1 });
		else if (r.job_id) enqueue(db, id, "cancel");
		// An unknown acceptance is reconciled only by an explicit request with the original key/body.
		return view(db, row(db, id)!);
	}
	const commandInTransaction = createCommands({
		...deps,
		enqueue,
		cancelInTransaction,
	});
	const discovery = createEnvironmentDiscovery(store, deps.port);
	return {
		refresh: discovery.refresh,
		close: discovery.close,
		needsDiscoveryInTransaction: discovery.needsDiscoveryInTransaction,
		commandInTransaction,
		cancelInTransaction,
		async submit(
			owner: string,
			conversationId: string,
			input: unknown,
			requestId: string,
			signal?: AbortSignal,
		) {
			const parsed = submitInput.safeParse(input);
			if (!parsed.success) throw new Error("invalid_request");
			signal?.throwIfAborted();
			if (!store.read((db) => commandRow(db, requestId)))
				await discovery.refresh(signal);
			return store.write((db) => {
				signal?.throwIfAborted();
				return commandInTransaction(
					db,
					owner,
					conversationId,
					"screen",
					"python_submit",
					parsed.data,
					requestId,
				).value;
			});
		},
		availableInTransaction: (db: Database) =>
			discovery.canSelectInTransaction(db) ||
			!!db.query("SELECT 1 FROM compute_jobs LIMIT 1").get(),
		snapshotInTransaction(
			db: Database,
			owner: string,
			conversationId?: string,
		) {
			const environment = savedEnvironment(db, deps.port()?.binding);
			const focus = db
				.query("SELECT job_id FROM compute_focus WHERE owner=?")
				.get(owner) as { job_id: string } | null;
			return {
				environment: environment?.environment ?? null,
				description: environment?.description ?? null,
				jobs: list(db, owner, conversationId),
				selectedJobId: focus?.job_id,
			};
		},
		readInTransaction(db: Database, owner: string, requestId: string) {
			const command = commandRow(db, requestId);
			return command?.owner === owner
				? (JSON.parse(command.result_json) as {
						action: string;
						jobId: string;
						job?: JobView;
					})
				: null;
		},
		currentInTransaction(db: Database, owner: string, requestId: string) {
			const value = this.readInTransaction(db, owner, requestId);
			if (!value) return null;
			return {
				job: view(db, owned(db, owner, value.jobId)),
				invalidated: !!owned(db, owner, value.jobId).invalidated,
			};
		},
		list: (owner: string) => store.read((db) => list(db, owner)),
		get: (owner: string, id: string) =>
			store.read((db) => view(db, owned(db, owner, id))),
		cancel: (owner: string, id: string) =>
			store.write((db) => cancelInTransaction(db, owner, id)),

		async confirmStop(owner: string, requestId: string) {
			const end = Date.now() + 10000;
			while (Date.now() < end) {
				const current = store.read((db) => {
					const command = db
						.query(
							"SELECT result_json FROM compute_commands WHERE owner=? AND request_id=?",
						)
						.get(owner, requestId) as { result_json: string } | null;
					return command
						? row(db, JSON.parse(command.result_json).jobId)
						: null;
				});
				if (!current) return false;
				if (
					["completed", "failed", "cancelled", "deleted"].includes(
						current.state,
					)
				)
					return true;
				if (current.state === "indeterminate") return false;
				await Bun.sleep(50);
			}
			return false;
		},
		async reconcile(owner: string, id: string) {
			return store.write((db) => {
				const r = owned(db, owner, id);
				if (
					r.state !== "indeterminate" ||
					(!r.job_id && Date.now() >= r.deadline)
				)
					throw new Error("compute_not_reconcilable");
				if (deps.port()?.binding !== r.binding)
					throw new Error("compute_connection_changed");
				patch(db, id, {
					...(r.cancel_requested || Date.now() >= r.deadline
						? { cancel_until: Date.now() + 30000 }
						: {}),
					error_code: null,
					announced: 0,
					state: r.job_id ? "running" : "submitting",
				});
				enqueue(
					db,
					id,
					r.job_id ? (r.cancel_requested ? "cancel" : "poll") : "reconcile",
				);
				return view(db, row(db, id)!);
			});
		},
		async delete(owner: string, id: string) {
			return store.write((db) => {
				const r = owned(db, owner, id);
				if (activeStates.includes(r.state) || r.state === "indeterminate")
					return cancelInTransaction(db, owner, id);
				if (r.state === "deleted") return view(db, r);
				if (!r.job_id) {
					patch(db, id, { state: "deleted" });
					return view(db, row(db, id)!);
				}
				if (!r.delete_requested) {
					patch(db, id, { delete_requested: 1 });
					enqueue(db, id, "delete");
				}
				return view(db, row(db, id)!);
			});
		},
		artifact(owner: string, id: string, artifactId: string) {
			return store.read((db) => {
				owned(db, owner, id);
				const a = db
					.query(
						"SELECT name,mime,content FROM compute_artifacts WHERE job_id=? AND id=?",
					)
					.get(id, artifactId) as {
					name: string;
					mime: string;
					content: Uint8Array;
				} | null;
				if (!a) throw new Error("compute_artifact_not_found");
				return a;
			});
		},
	};
}
export type ComputeService = ReturnType<typeof createCompute>;
