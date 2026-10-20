import { z } from "zod";
import type { SqliteStore } from "../../../infrastructure/sqlite";

const inputSchema = z.strictObject({
	expectedRevision: z.number().int().min(0),
	enabled: z.boolean(),
	token: z.string().trim().min(1).max(2048).optional(),
	clear: z.boolean().optional(),
});
type Row = { revision: number; enabled: number; encrypted: string };
const aad = "browser:bridge";

export function storedBridgeCiphertext(store: SqliteStore) {
	return store.read((db) => {
		if (
			!db
				.query(
					"SELECT 1 FROM sqlite_master WHERE name='settings_browser_bridge'",
				)
				.get()
		)
			return null;
		return (
			(
				db
					.query("SELECT encrypted FROM settings_browser_bridge WHERE id=1")
					.get() as { encrypted: string } | null
			)?.encrypted || null
		);
	});
}

/** A write-only profile credential. Only the backend-only accessor decrypts it. */
export function browserBridgeSettings(
	store: SqliteStore,
	encrypt: (s: string, id: string) => string,
	decrypt: (s: string, id: string) => string,
	available: () => boolean,
) {
	const listeners = new Set<() => Promise<void>>();
	const row = () =>
		store.read(
			(db) =>
				db
					.query(
						"SELECT revision,enabled,encrypted FROM settings_browser_bridge WHERE id=1",
					)
					.get() as Row | null,
		);
	const status = () => {
		const r = row();
		return {
			revision: r?.revision ?? 0,
			enabled: !!r?.enabled,
			configured: !!r?.encrypted,
			available: available(),
		};
	};
	return {
		browserBridge: status,
		browserBridgeCredential() {
			const r = row();
			if (!r?.enabled || !r.encrypted) return null;
			return decrypt(r.encrypted, aad);
		},
		onBrowserBridgeChange(fn: () => Promise<void>) {
			listeners.add(fn);
			return () => listeners.delete(fn);
		},
		async configureBrowserBridge(raw: unknown) {
			const parsed = inputSchema.safeParse(raw);
			if (!parsed.success) throw new Error("invalid_browser_bridge");
			const input = parsed.data;
			await store.write((db) => {
				const r = db
					.query(
						"SELECT revision,enabled,encrypted FROM settings_browser_bridge WHERE id=1",
					)
					.get() as Row | null;
				if ((r?.revision ?? 0) !== input.expectedRevision)
					throw new Error("conflict_browser_bridge");
				if (input.clear && input.token)
					throw new Error("invalid_browser_bridge");
				const encrypted = input.clear
					? ""
					: input.token
						? encrypt(input.token, aad)
						: (r?.encrypted ?? "");
				if (input.enabled && (!encrypted || !available()))
					throw new Error("invalid_browser_bridge_credential");
				db.query(
					`INSERT INTO settings_browser_bridge VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,enabled=excluded.enabled,encrypted=excluded.encrypted`,
				).run((r?.revision ?? 0) + 1, input.enabled ? 1 : 0, encrypted);
			});
			for (const fn of listeners) await fn();
			return status();
		},
	};
}
