import { createHash } from "node:crypto";
import { z } from "zod";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import { resolveLarmToken } from "../../../infrastructure/auth-config";
import { endpoint } from "../contracts/endpoints";
const privateGateway = endpoint.refine((value) => {
	const host = new URL(value).hostname.replace(/^\[|\]$/g, "");
	if (host === "localhost" || host === "::1" || host.endsWith(".local"))
		return true;
	const parts = host.split(".").map(Number);
	return (
		parts.length === 4 &&
		parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) &&
		(parts[0] === 127 ||
			parts[0] === 10 ||
			(parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
			(parts[0] === 192 && parts[1] === 168))
	);
});
const inputSchema = z.strictObject({
	expectedRevision: z.number().int().nonnegative(),
	baseUrl: privateGateway.refine((value) => new URL(value).pathname === "/"),
});
type Row = { revision: number; base_url: string };
export function ocrSettings(
	store: SqliteStore,
	env: Record<string, string | undefined>,
) {
	const row = () =>
		store.read(
			(db) =>
				db
					.query("SELECT revision,base_url FROM settings_ocr WHERE id=1")
					.get() as Row | null,
		);
	return {
		ocrConnection() {
			const r = row();
			return {
				revision: r?.revision ?? 0,
				serviceId: "ocr-host" as const,
				baseUrl: r?.base_url ?? null,
				credentialConfigured: !!r && !!resolveLarmToken(env),
			};
		},
		/** Backend-only: the shared LARM token is never sent to the browser or model. */
		ocrCredentials() {
			const r = row();
			const credential = resolveLarmToken(env);
			return r && credential
				? {
						revision: r.revision,
						baseUrl: r.base_url,
						credential,
						credentialVersion: createHash("sha256")
							.update(credential)
							.digest("hex"),
					}
				: null;
		},
		async configureOcr(raw: unknown) {
			const input = inputSchema.safeParse(raw);
			if (!input.success) throw new Error("invalid_ocr_settings");
			await store.write((db) => {
				const r = db
					.query("SELECT revision FROM settings_ocr WHERE id=1")
					.get() as { revision: number } | null;
				if ((r?.revision ?? 0) !== input.data.expectedRevision)
					throw new Error("revision_conflict");
				db.query(
					"INSERT INTO settings_ocr(id,revision,base_url) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,base_url=excluded.base_url",
				).run((r?.revision ?? 0) + 1, input.data.baseUrl);
			});
			return this.ocrConnection();
		},
	};
}
