import type { Database } from "bun:sqlite";
import { sha256Hex } from "../../../infrastructure/digest";
import {
	APPROVAL_MS,
	enqueueSchema,
	isFinal,
	type EnqueueRun,
	type ShellRun,
	type RunFinished,
} from "../contracts";
import * as repository from "../repository";
import type { ShellOptions } from "./types";

export function createLedger(options: ShellOptions) {
	const finished = new Set<(db: Database, run: RunFinished) => void>();
	const committed = new Set<(run: RunFinished) => void>();
	const pending = new Map<string, RunFinished>();
	const waiting = new Map<string, ShellRun>();
	const awaitingListeners = new Set<(run: ShellRun) => void>();
	const at = () => (options.now?.() ?? new Date()).toISOString();
	const expired = (run: ShellRun) =>
		Date.parse(run.createdAt) + APPROVAL_MS <=
		(options.now?.() ?? new Date()).getTime();
	const finalize = (
		db: Database,
		id: string,
		change: Partial<ShellRun> & { state: RunFinished["state"] },
		from: ShellRun["state"][] = ["queued", "running"],
	) => {
		if (
			!repository.transition(db, id, from, {
				...change,
				endedAt: at(),
				updatedAt: at(),
			})
		)
			return false;
		const run = repository.get(db, id)! as RunFinished;
		for (const listener of finished) listener(db, run);
		pending.set(id, run);
		return true;
	};
	return {
		finalize,
		enqueue(db: Database, input: EnqueueRun) {
			const parsed = enqueueSchema.safeParse(input);
			if (!parsed.success) throw new Error("shell_command_invalid");
			const r = {
				...parsed.data,
				timeoutSeconds: parsed.data.timeoutSeconds ?? 120,
			};
			const digest = sha256Hex(
				JSON.stringify([
					r.command,
					r.task,
					r.projectId,
					r.timeoutSeconds,
					r.origin,
					r.conversationId ?? null,
				]),
			);
			const saved = repository.get(db, r.attemptId);
			if (saved) {
				if (saved.digest !== digest) throw new Error("shell_run_conflict");
				return saved;
			}
			if (!options.store) throw new Error("shell_tracking_unavailable");
			if (!options.projects?.(r.projectId))
				throw new Error("shell_project_unknown");
			const created = at();
			repository.insert(db, {
				...r,
				id: r.attemptId,
				digest,
				state: r.origin === "conversation" ? "awaiting_approval" : "queued",
				output: "",
				outputTruncated: false,
				createdAt: created,
				updatedAt: created,
			});
			const run = repository.get(db, r.attemptId)!;
			if (run.state === "awaiting_approval") waiting.set(run.id, run);
			return run;
		},
		approve(db: Database, id: string, digest: string) {
			const saved = repository.get(db, id);
			if (!saved || saved.state !== "awaiting_approval")
				throw new Error("shell_not_found");
			if (sha256Hex(saved.command) !== digest)
				throw new Error("shell_run_conflict");
			if (expired(saved)) {
				if (
					!finalize(
						db,
						id,
						{ state: "cancelled", reason: "approval_expired" },
						["awaiting_approval"],
					)
				)
					throw new Error("shell_not_found");
				// The caller commits this write, then reports the run as gone.
				return "expired" as const;
			}
			if (
				!repository.transition(db, id, ["awaiting_approval"], {
					state: "queued",
					updatedAt: at(),
				})
			)
				throw new Error("shell_not_found");
			return repository.get(db, id)!;
		},
		cancel(db: Database, id: string) {
			return finalize(
				db,
				id,
				{ state: "cancelled", reason: "cancelled_by_person" },
				["awaiting_approval", "queued"],
			);
		},
		async recover() {
			await options.store?.write((db) => {
				for (const r of repository.list(db, true)) {
					if (r.state === "awaiting_approval") {
						if (expired(r))
							finalize(
								db,
								r.id,
								{ state: "cancelled", reason: "approval_expired" },
								["awaiting_approval"],
							);
						continue;
					}
					finalize(db, r.id, {
						state: r.state === "queued" ? "cancelled" : "unknown",
						reason: "restarted",
					});
				}
			});
		},
		flushCommitted() {
			const held = [...waiting.values()];
			waiting.clear();
			for (const run of held) {
				const saved = options.store?.read((db) => repository.get(db, run.id));
				if (!saved || saved.state !== "awaiting_approval") continue;
				for (const listener of awaitingListeners) listener(saved);
			}
			const events = [...pending.values()];
			pending.clear();
			for (const r of events) {
				const saved = options.store?.read((db) => repository.get(db, r.id));
				if (
					!saved ||
					!isFinal(saved.state) ||
					saved.state !== r.state ||
					saved.updatedAt !== r.updatedAt
				)
					continue;
				for (const listener of committed) listener(r);
			}
		},
		onFinishedInTransaction(
			listener: (db: Database, run: RunFinished) => void,
		) {
			finished.add(listener);
			return () => {
				finished.delete(listener);
			};
		},
		onAwaitingCommitted(listener: (run: ShellRun) => void) {
			awaitingListeners.add(listener);
			return () => {
				awaitingListeners.delete(listener);
			};
		},
		onFinishedCommitted(listener: (run: RunFinished) => void) {
			committed.add(listener);
			return () => {
				committed.delete(listener);
			};
		},
	};
}
