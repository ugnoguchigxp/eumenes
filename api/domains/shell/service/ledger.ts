import type { Database } from "bun:sqlite";
import { sha256Hex } from "../../../infrastructure/digest";
import {
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
	const at = () => (options.now?.() ?? new Date()).toISOString();
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
			repository.insert(db, {
				...r,
				id: r.attemptId,
				digest,
				state: "queued",
				output: "",
				outputTruncated: false,
				createdAt: at(),
				updatedAt: at(),
			});
			return repository.get(db, r.attemptId)!;
		},
		cancel(db: Database, id: string) {
			return finalize(
				db,
				id,
				{ state: "cancelled", reason: "cancelled_by_person" },
				["queued"],
			);
		},
		async recover() {
			await options.store?.write((db) => {
				for (const r of repository.list(db, true))
					finalize(db, r.id, {
						state: r.state === "queued" ? "cancelled" : "unknown",
						reason: "restarted",
					});
			});
		},
		flushCommitted() {
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
		onFinishedCommitted(listener: (run: RunFinished) => void) {
			committed.add(listener);
			return () => {
				committed.delete(listener);
			};
		},
	};
}
