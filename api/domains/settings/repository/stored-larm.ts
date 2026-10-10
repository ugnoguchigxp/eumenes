import { Database } from "bun:sqlite";
import { read } from ".";
import type { Settings } from "../contracts";

/** Backend evaluation reads only the persisted LARM connection; no migrations or writes. */
export function readStoredLarm(dbPath: string): Settings["larm"] {
	const db = new Database(dbPath, { readonly: true });
	try {
		return read(db).larm;
	} finally {
		db.close();
	}
}
