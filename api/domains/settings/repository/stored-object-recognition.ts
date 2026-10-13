import { Database } from "bun:sqlite";
/** Backend read-only readiness operation. No migrations, credentials or provider calls. */
export function readStoredObjectRecognitionConnection(dbPath: string) {
	const db = new Database(dbPath, { readonly: true });
	try {
		const exists = db
			.query(
				"SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings_object_recognition'",
			)
			.get();
		const hasSource =
			exists &&
			(
				db.query("PRAGMA table_info(settings_object_recognition)").all() as {
					name: string;
				}[]
			).some((column) => column.name === "credential_source");
		const row = exists
			? (db
					.query(
						`SELECT revision,base_url${hasSource ? ",credential_source" : ""} FROM settings_object_recognition WHERE id=1`,
					)
					.get() as {
					revision: number;
					base_url: string;
					credential_source?: "dedicated" | "larm";
				} | null)
			: null;
		return {
			serviceId: "object-recognition-host",
			revision: row?.revision ?? 0,
			baseUrl: row?.base_url ?? null,
			configured: !!row,
			credentialSource: row?.credential_source ?? "dedicated",
			formalDeployment: "unconfirmed",
		};
	} finally {
		db.close();
	}
}
