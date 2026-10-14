import type { SqliteStore } from "../../../infrastructure/sqlite";
import { settingsSchema } from "../contracts";

/**
 * The saved `world.enabled` for backend startup. A store without a settings
 * document yet (settings not created) means the default: false.
 */
export function readStoredWorldEnabled(store: SqliteStore): boolean {
	return store.read((db) => {
		const row = db
			.query("SELECT document FROM settings_document WHERE id=1")
			.get() as { document: string } | null;
		return row
			? settingsSchema.parse(JSON.parse(row.document)).world.enabled
			: false;
	});
}
