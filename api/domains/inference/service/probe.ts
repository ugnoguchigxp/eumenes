import type { Database } from "bun:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import type { SqliteStore } from "../../../infrastructure/sqlite";

/** A "running" probe older than this lost its final update; its task cannot still be alive. */
export const PROBE_STALE_MS = 10 * 60_000;
const WRITE_RETRY_DELAYS_MS = [200, 400, 800] as const;

/**
 * Retries a bookkeeping write while the single writer is momentarily saturated,
 * so a probe row is not left "running" until the next restart.
 */
export async function writeWithRetry<T>(
	write: () => Promise<T>,
	delaysMs: readonly number[] = WRITE_RETRY_DELAYS_MS,
): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await write();
		} catch (error) {
			const message = error instanceof Error ? error.message : "";
			if (
				attempt >= delaysMs.length ||
				message === "database_closing" ||
				message === "database_writer_owned"
			)
				throw error;
			await delay(delaysMs[attempt]!);
		}
	}
}

/** Registers a running probe; stale "running" rows are failed first so they cannot block it forever. */
export function openProbe(
	db: Database,
	id: string,
	target: string,
	revision: number,
) {
	db.query(
		"UPDATE inference_probes SET status='failed',error='probe_stale' WHERE status='running' AND created<?",
	).run(Date.now() - PROBE_STALE_MS);
	if (db.query("SELECT id FROM inference_probes WHERE status='running'").get())
		throw new Error("invalid_probe_busy");
	return db
		.query("INSERT INTO inference_probes VALUES(?,?,'running',NULL,?,?)")
		.run(id, target, revision, Date.now());
}

/** Writes the terminal probe status, retrying while the writer queue is full. */
export function finishProbe(
	store: SqliteStore,
	id: string,
	status: "succeeded" | "stale" | "cancelled" | "failed",
	error?: string,
) {
	return writeWithRetry(() =>
		store.write((db) =>
			error === undefined
				? db
						.query("UPDATE inference_probes SET status=? WHERE id=?")
						.run(status, id)
				: db
						.query("UPDATE inference_probes SET status=?,error=? WHERE id=?")
						.run(status, error, id),
		),
	);
}
