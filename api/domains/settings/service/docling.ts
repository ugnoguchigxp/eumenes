import { createHash } from "node:crypto";
import { z } from "zod";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import { resolveLarmToken } from "../../../infrastructure/auth-config";
import { endpoint } from "../contracts/endpoints";

const origin = endpoint.refine((value) => {
	let u: URL;
	try {
		u = new URL(value);
	} catch {
		return false;
	}
	return (
		u.protocol === "http:" &&
		["127.0.0.1", "localhost"].includes(u.hostname) &&
		u.port === "28765" &&
		u.pathname === "/"
	);
});
const input = z.strictObject({
	expectedRevision: z.number().int().nonnegative(),
	gatewayUrl: origin,
	publicOrigin: origin,
});
type Row = { revision: number; gateway_url: string; public_origin: string };

export function doclingSettings(
	store: SqliteStore,
	env: Record<string, string | undefined>,
) {
	const row = () =>
		store.read(
			(db) =>
				db
					.query("SELECT * FROM settings_docling WHERE id=1")
					.get() as Row | null,
		);
	return {
		doclingConnection() {
			const r = row();
			return {
				revision: r?.revision ?? 0,
				gatewayUrl: r?.gateway_url ?? null,
				publicOrigin: r?.public_origin ?? null,
				credentialConfigured: !!resolveLarmToken(env),
			};
		},
		/** Backend only; the existing shared credential never enters settings responses. */
		doclingCredentials() {
			const r = row(),
				credential = resolveLarmToken(env);
			if (!r || !credential) return null;
			return {
				revision: r.revision,
				gatewayUrl: r.gateway_url,
				publicOrigin: r.public_origin,
				credential,
				version: `${r.revision}:${createHash("sha256").update(credential).digest("hex")}`,
			};
		},
		async configureDocling(raw: unknown) {
			const parsed = input.safeParse(raw);
			if (!parsed.success) throw new Error("invalid_docling_settings");
			await store.write((db) => {
				const current = db
					.query("SELECT revision FROM settings_docling WHERE id=1")
					.get() as { revision: number } | null;
				if ((current?.revision ?? 0) !== parsed.data.expectedRevision)
					throw new Error("revision_conflict");
				db.query(
					"INSERT INTO settings_docling VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,gateway_url=excluded.gateway_url,public_origin=excluded.public_origin",
				).run(
					(current?.revision ?? 0) + 1,
					new URL(parsed.data.gatewayUrl).origin,
					new URL(parsed.data.publicOrigin).origin,
				);
			});
			return this.doclingConnection();
		},
	};
}
