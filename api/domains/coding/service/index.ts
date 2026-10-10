import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import { sha256Hex } from "../../../infrastructure/digest";
import {
	executionSpecSchema,
	canonicalJSON,
	receiptSchema,
	inspectSchema,
	type ExecutionSpec,
	type ExecutionReceipt,
	type RunnerPort,
} from "../../../../packages/coding-runner/src/contracts";
import { type CodingExecutionView } from "../contracts";
import * as repo from "../repository";

const hash = (value: unknown) => sha256Hex(canonicalJSON(value));
export interface CodingAuthority {
	taskId: string;
	generation: number;
	authorityEpoch: number;
	workspaceId: string;
	branch: string | null;
	operations: ExecutionSpec["operations"];
	network: ExecutionSpec["network"];
	deadlineAt: number;
}
export function createCoding(input: {
	store: SqliteStore;
	runner: RunnerPort;
	publishSpec: (specRef: string, spec: ExecutionSpec) => void;
	now?: () => number;
}) {
	const { store, runner } = input;
	const now = input.now ?? Date.now;
	function requireRow(db: Database, id: string) {
		const row = repo.get(db, id);
		if (!row) throw new Error("coding_execution_not_found");
		return row;
	}
	function requireAuthority(
		row: repo.ExecutionRow,
		authority: CodingAuthority,
		allowExpired = false,
	) {
		const spec = executionSpecSchema.parse(JSON.parse(row.spec_json));
		if (
			spec.taskId !== authority.taskId ||
			spec.generation !== authority.generation ||
			spec.authorityEpoch !== authority.authorityEpoch ||
			spec.workspaceId !== authority.workspaceId ||
			spec.network !== authority.network ||
			JSON.stringify([...spec.operations].sort()) !==
				JSON.stringify([...authority.operations].sort()) ||
			(!allowExpired &&
				(authority.deadlineAt <= now() ||
					spec.deadlineAt <= now() ||
					authority.deadlineAt > spec.deadlineAt))
		)
			throw new Error("coding_authority_stale");
		return spec;
	}
	function view(db: Database, row: repo.ExecutionRow): CodingExecutionView {
		const r = row.receipt_json
			? receiptSchema.parse(JSON.parse(row.receipt_json))
			: null;
		return {
			id: row.id,
			taskId: row.task_id,
			generation: row.generation,
			authorityEpoch: row.epoch,
			state: row.state as CodingExecutionView["state"],
			cursor: repo.cursor(db, row.id),
			turnFinished: r?.turnFinished ?? false,
			childrenStopped:
				row.state !== "outcome_unknown" && (r?.childrenStopped ?? false),
			evidenceComplete:
				row.state !== "outcome_unknown" && (r?.evidenceComplete ?? false),
			reason:
				row.state === "outcome_unknown"
					? "requires_reconciliation"
					: (r?.reason ?? null),
			exitCode: r?.exitCode ?? null,
			createdAt: new Date(row.created_ms).toISOString(),
			updatedAt: new Date(row.updated_ms).toISOString(),
		};
	}
	function prepareInTransaction(
		db: Database,
		authority: CodingAuthority,
		command: {
			operationId: string;
			instruction: string;
			kind: ExecutionSpec["kind"];
			previousExecutionId?: string;
		},
	) {
		const old = repo.operation(db, command.operationId);
		const commandDigest = hash({ authority, command });
		if (old) {
			if (old.digest !== commandDigest)
				throw new Error("coding_operation_conflict");
			return {
				spec: executionSpecSchema.parse(
					JSON.parse(requireRow(db, old.execution_id).spec_json),
				),
				specRef: old.spec_ref,
			};
		}
		const w = repo.getWorkspace(db, authority.workspaceId);
		if (!w || !w.available) throw new Error("coding_workspace_unavailable");
		if (authority.branch !== null && authority.branch !== w.branch)
			throw new Error("coding_branch_conflict");
		if (
			authority.deadlineAt <= now() ||
			!authority.operations.includes("read") ||
			(command.kind === "review" && !authority.operations.includes("review"))
		)
			throw new Error("coding_authority_stale");
		if (repo.reservation(db, w.id)) throw new Error("coding_workspace_busy");
		let sessionId: string | null = null;
		if (command.kind === "continue") {
			if (!command.previousExecutionId)
				throw new Error("coding_session_required");
			const previous = requireRow(db, command.previousExecutionId);
			const spec = requireAuthority(previous, authority);
			const r = previous.receipt_json
				? receiptSchema.parse(JSON.parse(previous.receipt_json))
				: null;
			if (
				!r ||
				!r.sessionId ||
				!r.childrenStopped ||
				!r.turnFinished ||
				!r.evidenceComplete ||
				repo.cursor(db, previous.id) !== r.seq ||
				repo.latest(db, authority.taskId)?.id !== previous.id ||
				!["stopped", "exited"].includes(previous.state) ||
				spec.taskId !== authority.taskId
			)
				throw new Error("coding_session_not_ready");
			sessionId = r.sessionId;
		}
		const spec = executionSpecSchema.parse({
			version: "eumenes-coding/1",
			executionId: crypto.randomUUID(),
			operationId: command.operationId,
			taskId: authority.taskId,
			workspaceId: w.id,
			generation: authority.generation,
			authorityEpoch: authority.authorityEpoch,
			kind: command.kind,
			instruction: command.instruction,
			sessionId,
			deadlineAt: authority.deadlineAt,
			operations: authority.operations,
			network: authority.network,
			previousExecutionId: command.previousExecutionId ?? null,
		});
		const specRef = crypto.randomUUID();
		repo.insert(db, spec, commandDigest, specRef, now());
		return { spec, specRef };
	}
	function acceptInTransaction(
		db: Database,
		authority: CodingAuthority,
		raw: ExecutionReceipt,
		allowExpired = false,
	) {
		const r = receiptSchema.parse(raw);
		const row = requireRow(db, r.executionId);
		if (repo.latest(db, row.task_id)?.id !== row.id)
			throw new Error("coding_execution_stale");
		const spec = requireAuthority(row, authority, allowExpired);
		if (
			r.operationId !== spec.operationId ||
			r.generation !== spec.generation ||
			r.specDigest !== sha256Hex(canonicalJSON(spec))
		)
			throw new Error("coding_receipt_conflict");
		const previous = row.receipt_json
			? receiptSchema.parse(JSON.parse(row.receipt_json))
			: null;
		if (
			previous &&
			(r.seq < previous.seq ||
				r.updatedAt < previous.updatedAt ||
				(previous.sessionId !== null && r.sessionId !== previous.sessionId) ||
				(previous.childrenStopped &&
					(!r.childrenStopped || r.state !== previous.state)) ||
				(previous.state === "stopping" &&
					["reserved", "running"].includes(r.state)) ||
				(previous.turnFinished && !r.turnFinished) ||
				(!previous.evidenceComplete && r.evidenceComplete))
		)
			throw new Error("coding_receipt_stale");
		repo.updateReceipt(db, r, allowExpired);
		return view(db, requireRow(db, r.executionId));
	}
	function adoptInTransaction(
		db: Database,
		authority: CodingAuthority,
		inspection: unknown,
	) {
		const batch = inspectSchema.parse(inspection);
		const row = requireRow(db, batch.receipt.executionId);
		requireAuthority(row, authority);
		let cursor = repo.cursor(db, row.id);
		for (const e of batch.events) {
			if (e.executionId !== row.id || e.generation !== row.generation)
				throw new Error("coding_event_conflict");
			if (e.seq <= cursor) {
				if (
					canonicalJSON(repo.oneEvent(db, row.id, e.seq)) !== canonicalJSON(e)
				)
					throw new Error("coding_event_digest_conflict");
			} else {
				if (e.seq !== cursor + 1) throw new Error("coding_event_gap");
				repo.append(db, e);
				cursor = e.seq;
			}
		}
		if (
			batch.nextCursor !== cursor ||
			batch.receipt.seq < cursor ||
			batch.hasMore !== cursor < batch.receipt.seq
		)
			throw new Error("coding_cursor_conflict");
		return acceptInTransaction(db, authority, batch.receipt);
	}
	return {
		prepareInTransaction,
		acceptInTransaction,
		adoptInTransaction,
		confirmStoppedInTransaction(
			db: Database,
			taskId: string,
			generation: number,
			r: ExecutionReceipt,
		) {
			const row = requireRow(db, r.executionId);
			const spec = executionSpecSchema.parse(JSON.parse(row.spec_json));
			if (
				row.task_id !== taskId ||
				row.generation !== generation ||
				!r.childrenStopped ||
				!["stopped", "exited"].includes(r.state)
			)
				throw new Error("coding_stop_unconfirmed");
			return acceptInTransaction(
				db,
				{
					taskId,
					generation,
					authorityEpoch: spec.authorityEpoch,
					workspaceId: spec.workspaceId,
					branch: null,
					operations: spec.operations,
					network: spec.network,
					deadlineAt: spec.deadlineAt,
				},
				r,
				true,
			);
		},
		preparedInTransaction(db: Database, operationId: string) {
			const op = repo.operation(db, operationId);
			if (!op) throw new Error("coding_intent_missing");
			return {
				spec: executionSpecSchema.parse(
					JSON.parse(requireRow(db, op.execution_id).spec_json),
				),
				specRef: op.spec_ref,
			};
		},
		registerWorkspaceInTransaction: repo.registerWorkspace,
		workspaceInTransaction: repo.getWorkspace,
		latestInTransaction(db: Database, taskId: string) {
			const row = repo.latest(db, taskId);
			return row ? view(db, row) : null;
		},
		specInTransaction(db: Database, id: string) {
			return executionSpecSchema.parse(
				JSON.parse(requireRow(db, id).spec_json),
			);
		},
		cursorInTransaction: repo.cursor,
		liveInTransaction(db: Database) {
			return repo.live(db).map((r) => view(db, r));
		},
		unknownInTransaction: (db: Database, id: string) =>
			repo.unknown(db, id, now()),
		async dispatch(
			prepared: { spec: ExecutionSpec; specRef: string },
			signal?: AbortSignal,
		) {
			input.publishSpec(prepared.specRef, prepared.spec);
			return runner.start(prepared.specRef, prepared.spec, signal);
		},
		publish(prepared: { spec: ExecutionSpec; specRef: string }) {
			input.publishSpec(prepared.specRef, prepared.spec);
		},
		inspect: runner.inspect,
		stop: runner.stop,
		readEvidence: runner.readEvidence,
		probe: runner.probe,
		workspaces: () => store.read(repo.workspaces),
		get: (id: string) =>
			store.readSnapshot((db) => view(db, requireRow(db, id))),
		events(id: string, after = 0, limit = 100) {
			if (
				!Number.isSafeInteger(after) ||
				after < 0 ||
				!Number.isSafeInteger(limit) ||
				limit < 1 ||
				limit > 100
			)
				throw new Error("coding_invalid_cursor");
			return store.readSnapshot((db) => {
				const row = requireRow(db, id);
				if (after > repo.cursor(db, id))
					throw new Error("coding_invalid_cursor");
				return {
					execution: view(db, row),
					events: repo.events(db, id, after, limit),
				};
			});
		},
		async recover() {
			return store.write((db) => {
				for (const row of repo.live(db)) repo.unknown(db, row.id, now());
			});
		},
		close: runner.close,
	};
}
export type CodingService = ReturnType<typeof createCoding>;
