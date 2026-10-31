import type { SqliteStore } from "../../../infrastructure/sqlite";
import {
	activeStatuses,
	type LiveConversationPort,
	type LiveSnapshot,
} from "../contracts";
import { session } from "../repository";
import type { Runtime } from "./runtime";
import { publishSegments } from "./transcripts";
/** Even when SQLite cannot commit the terminal state, a failed connection must stop sending and executing. */
export function createTerminator({
	store,
	runtimes,
	conversation,
	clock,
	state,
}: {
	store: SqliteStore;
	runtimes: Map<string, Runtime>;
	conversation: LiveConversationPort;
	clock: () => string;
	state: (id: string) => LiveSnapshot | null;
}) {
	async function finish(
		id: string,
		status: "closed" | "failed" | "interrupted",
		error: string | null = null,
		usage?: unknown,
	) {
		const runtime = runtimes.get(id);
		if (runtime?.failed) {
			status = "failed";
			error = "live_storage_failed";
		}
		if (runtime) {
			clearTimeout(runtime.closeTimer);
			clearTimeout(runtime.attachTimer);
			clearTimeout(runtime.startupTimer);
			clearTimeout(runtime.delegationTimer);
			clearTimeout(runtime.flushTimer);
		}
		try {
			await store.write((db) => {
				const row = session(db, id);
				if (!row || !activeStatuses.includes(row.status)) return;
				publishSegments(db, id, conversation, clock());
				if (row.test) {
					db.query("DELETE FROM live_voice_fragments WHERE session_id=?").run(
						id,
					);
					db.query("DELETE FROM live_voice_segments WHERE session_id=?").run(
						id,
					);
				}
				db.query(
					"UPDATE live_voice_sessions SET status=?,error=?,usage_confirmed=?,usage=? WHERE id=?",
				).run(
					status,
					error,
					usage !== undefined ? 1 : 0,
					usage === undefined ? null : JSON.stringify(usage),
					id,
				);
			});
			runtimes.delete(id);
		} catch {
			if (runtime) runtime.failed = true;
			else throw new Error("live_storage_failed");
		}
		try {
			const value = state(id);
			if (value && runtime?.listener)
				runtime.listener({ type: "state", state: value });
		} catch {
			/* A failed read is surfaced by closing the stream. */
		}
		runtime?.socket.close();
	}

	return finish;
}
