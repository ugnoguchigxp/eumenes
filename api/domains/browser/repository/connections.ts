import type { Database } from "bun:sqlite";
import type { ConnectionState } from "../contracts";
import { patchRow } from "./sql";

export type ConnectionRow = {
	credential_revision: number;
	id: string;
	state: ConnectionState;
	started_at: number;
	connected_at: number | null;
	ended_at: number | null;
	end_reason: string | null;
	revision: number;
	updated_at: number;
};

export const connectionRow = (db: Database, id: string) =>
	db
		.query("SELECT * FROM browser_connections WHERE id=?")
		.get(id) as ConnectionRow | null;

/** The one connection that is starting or live; at most one exists. */
export const activeConnection = (db: Database) =>
	db
		.query(
			"SELECT * FROM browser_connections WHERE state IN ('connecting','connected') ORDER BY started_at DESC LIMIT 1",
		)
		.get() as ConnectionRow | null;

export const lastConnection = (db: Database) =>
	db
		.query(
			"SELECT * FROM browser_connections ORDER BY started_at DESC, rowid DESC LIMIT 1",
		)
		.get() as ConnectionRow | null;

export function insertConnection(db: Database, id: string, now: number) {
	db.query(
		"INSERT INTO browser_connections(id,state,started_at,updated_at) VALUES(?,?,?,?)",
	).run(id, "connecting", now, now);
}

export function patchConnection(
	db: Database,
	id: string,
	change: Partial<
		Pick<ConnectionRow, "state" | "connected_at" | "ended_at" | "end_reason">
	>,
	now: number,
) {
	patchRow(db, "browser_connections", "id", id, change, now);
}

export const connectionCount = (db: Database) =>
	(
		db
			.query("SELECT COALESCE(SUM(revision+1),0) AS n FROM browser_connections")
			.get() as {
			n: number;
		}
	).n;
