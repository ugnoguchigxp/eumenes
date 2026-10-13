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

/** Read-only deployment check, also usable before the new migration has been installed. */
export function readStoredExcalidrawAvailability(dbPath: string) {
	const db = new Database(dbPath, { readonly: true });
	try {
		if (
			!db
				.query(
					"SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings_excalidraw'",
				)
				.get()
		)
			return { configured: false, reason: "settings_not_installed" };
		const row = db
			.query(
				"SELECT revision,gateway_url,lease_endpoint,length(consumer) AS consumer_length,length(app) AS app_length FROM settings_excalidraw WHERE id=1",
			)
			.get() as {
			revision: number;
			gateway_url: string;
			lease_endpoint: string;
			consumer_length: number;
			app_length: number;
		} | null;
		return row
			? {
					configured: !!row.consumer_length && !!row.app_length,
					revision: row.revision,
					gatewayUrl: row.gateway_url,
					leaseEndpoint: row.lease_endpoint,
				}
			: { configured: false, reason: "consumer_not_configured" };
	} finally {
		db.close();
	}
}
