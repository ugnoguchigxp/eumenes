import type { Database } from "bun:sqlite";
import type { CodexAttempt } from "../contracts";
import { attempt } from ".";

export type AttemptResource = { attempt: CodexAttempt; createdAt: number };

/** One attempt with the time it was accepted. */
export function attemptResource(
	db: Database,
	id: string,
): AttemptResource | null {
	const found = attempt(db, id);
	if (!found) return null;
	const row = db
		.query("SELECT created_at FROM codex_task_attempts WHERE id=?")
		.get(id) as { created_at: number };
	return { attempt: found, createdAt: row.created_at };
}

/** Every attempt, newest first. */
export const attemptResources = (db: Database): AttemptResource[] =>
	(
		db
			.query("SELECT id FROM codex_task_attempts ORDER BY seq DESC")
			.all() as Array<{ id: string }>
	).map(({ id }) => attemptResource(db, id)!);
