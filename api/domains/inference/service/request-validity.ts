import type { Database } from "bun:sqlite";
import type { Connection, SettingsService } from "../../settings";
import { get, type RequestRow } from "../repository";
import type { Running } from "./execute-types";

/** Whether a request may still run or be adopted under the settings and parents it was captured with. */
export function createRequestValidity({
	settings,
	active,
}: {
	settings: SettingsService;
	/** Requests running now: a TTS request lives while its parent answer is still arriving. */
	active: Map<string, Running>;
}) {
	function resolve(row: RequestRow) {
		const id = row.snapshot.routes[row.purpose].fallbackId;
		const resource = row.snapshot.resources.find((r) => r.id === id);
		const connection = row.snapshot.connections.find(
			(c) => c.id === resource?.connectionId,
		);
		return resource && connection ? { resource, connection } : null;
	}
	function allowed(db: Database, row: RequestRow, connection?: Connection) {
		return (
			get(db, row.id)?.status === "pending" &&
			(!row.subject.startsWith("background:") ||
				settings.inTransaction(db).revision === row.snapshot.revision) &&
			row.deadline > Date.now() &&
			settings.valid(db, row.snapshot, row.purpose, connection) &&
			row.parents.every((id) =>
				row.purpose === "tts" ? usable(db, id) : valid(db, id),
			)
		);
	}

	function valid(db: Database, id: string) {
		const row = get(db, id);
		if (
			!row ||
			row.status !== "accepted" ||
			(row.subject.startsWith("background:") &&
				settings.inTransaction(db).revision !== row.snapshot.revision) ||
			!row.parents.every((parent) =>
				row.purpose === "tts" ? usable(db, parent) : valid(db, parent),
			)
		)
			return false;
		const selected = resolve(row);
		const cloud = db
			.query(
				"SELECT id FROM inference_attempts WHERE request_id=? AND source='cloud' AND accepted=1",
			)
			.get(id);
		return settings.valid(
			db,
			row.snapshot,
			row.purpose,
			cloud ? selected?.connection : undefined,
		);
	}

	// TTS is provisional while its parent answer is still arriving. It cannot
	// outlive cancellation/revocation or authorize a non-TTS dependent request.
	function usable(db: Database, id: string): boolean {
		const row = get(db, id);
		if (!row) return false;
		if (row.status === "accepted") return valid(db, id);
		if (
			row.status !== "pending" ||
			row.purpose !== "llm" ||
			row.deadline <= Date.now() ||
			!row.parents.every((parent) => valid(db, parent))
		)
			return false;
		const running = active.get(id);
		const completed = db
			.query(
				"SELECT source,connection_id FROM inference_attempts WHERE request_id=? AND status='succeeded' ORDER BY started DESC LIMIT 1",
			)
			.get(id) as { source: string; connection_id: string | null } | null;
		if ((!running || running.controller.signal.aborted) && !completed)
			return false;
		const connection =
			running?.connection ??
			(completed?.source === "cloud"
				? row.snapshot.connections.find((c) => c.id === completed.connection_id)
				: undefined);
		return settings.valid(db, row.snapshot, row.purpose, connection);
	}

	return { resolve, allowed, valid, usable };
}
