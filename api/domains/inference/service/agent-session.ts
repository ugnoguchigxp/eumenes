import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { AgentAuth } from "../../settings/contracts";

/**
 * The ledger of Claude Agent SDK session ids (`inference_agent_sessions`; inference is its only writer). It holds
 * no history: only which id a combination uses and what was learned about its model. A `main` row is one per
 * connection × auth × model; a `subagent` row is one per task × connection × auth × model.
 */
export type AgentSessionKey = {
	role: "main" | "subagent";
	/** `subagent` only. */
	taskId?: string;
	connectionId: string;
	auth: AgentAuth;
	model: string;
};

/** A task's sessions that were never released (a crash, a forgotten call) are dropped after this long. */
export const TASK_SESSION_TTL_MS = 24 * 60 * 60_000;

/** The session id of a combination: issued by the host on first use, the same afterwards. */
export function acquireAgentSession(
	store: SqliteStore,
	key: AgentSessionKey,
	now = Date.now(),
): Promise<string> {
	return store.write((db) => {
		const taskId = key.role === "subagent" ? (key.taskId ?? null) : null;
		if (key.role === "subagent" && taskId === null)
			throw new Error("invalid_session_role");
		const existing = db
			.query(
				"SELECT id FROM inference_agent_sessions WHERE role=? AND task_id IS ? AND connection_id=? AND auth=? AND model=?",
			)
			.get(key.role, taskId, key.connectionId, key.auth, key.model) as {
			id: string;
		} | null;
		if (existing) {
			db.query("UPDATE inference_agent_sessions SET updated=? WHERE id=?").run(
				now,
				existing.id,
			);
			return existing.id;
		}
		const id = crypto.randomUUID();
		db.query(
			"INSERT INTO inference_agent_sessions(id,role,task_id,connection_id,auth,model,created,updated) VALUES(?,?,?,?,?,?,?,?)",
		).run(
			id,
			key.role,
			taskId,
			key.connectionId,
			key.auth,
			key.model,
			now,
			now,
		);
		return id;
	});
}

/** The model's context window as the CLI reported it after a turn. */
export function learnContextWindow(
	store: SqliteStore,
	id: string,
	contextWindow: number,
): Promise<void> {
	return store.write((db) => {
		db.query(
			"UPDATE inference_agent_sessions SET learned_context_window=? WHERE id=?",
		).run(contextWindow, id);
	});
}

/** What the ledger learned about a connection's models: a model that reported a context window, by model id. */
export function learnedContextWindows(
	store: SqliteStore,
	connectionId: string,
	auth: AgentAuth,
): Map<string, number> {
	const rows = store.read((db) =>
		db
			.query(
				"SELECT model, MAX(learned_context_window) AS window FROM inference_agent_sessions WHERE connection_id=? AND auth=? AND learned_context_window IS NOT NULL GROUP BY model",
			)
			.all(connectionId, auth),
	) as Array<{ model: string; window: number }>;
	return new Map(rows.map((row) => [row.model, row.window]));
}

/** The SDK's own delete: the row goes (there is no history to remove). */
export function dropAgentSession(store: SqliteStore, id: string) {
	return store.write((db) => {
		db.query("DELETE FROM inference_agent_sessions WHERE id=?").run(id);
	});
}

/** A task reported its result: none of its sessions carries over to another task. */
export function releaseTaskSessions(store: SqliteStore, taskId: string) {
	return store.write((db) => {
		db.query(
			"DELETE FROM inference_agent_sessions WHERE role='subagent' AND task_id=?",
		).run(taskId);
	});
}

/** Task sessions nobody released (or touched) within the TTL; returns how many were removed. */
export function sweepTaskSessions(
	store: SqliteStore,
	now = Date.now(),
	ttlMs = TASK_SESSION_TTL_MS,
) {
	return store.write(
		(db) =>
			db
				.query(
					"DELETE FROM inference_agent_sessions WHERE role='subagent' AND updated<?",
				)
				.run(now - ttlMs).changes,
	);
}
