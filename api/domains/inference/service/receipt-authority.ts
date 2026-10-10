import type { Database } from "bun:sqlite";
import type { Connection } from "../../settings";
import type { Receipt } from "../contracts";
import { get, type RequestRow } from "../repository";

/** Read-only authority check shared by control delegation and answer adoption. */
export function validateReceipt(
	db: Database,
	receipt: Receipt,
	allowed: (db: Database, row: RequestRow, connection?: Connection) => boolean,
) {
	const row = get(db, receipt.requestId);
	const attempt = db
		.query(
			"SELECT source,connection_id,status FROM inference_attempts WHERE id=? AND request_id=?",
		)
		.get(receipt.attemptId, receipt.requestId) as {
		source: string;
		connection_id: string | null;
		status: string;
	} | null;
	if (!row || !attempt || attempt.status !== "succeeded") return false;
	const connection =
		attempt.source === "cloud"
			? row.snapshot.connections.find((c) => c.id === attempt.connection_id)
			: undefined;
	return allowed(db, row, connection);
}
