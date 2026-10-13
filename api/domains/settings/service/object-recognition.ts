import { z } from "zod";
import { createHash } from "node:crypto";
import { resolveLarmToken } from "../../../infrastructure/auth-config";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import { cloudEndpoint } from "../contracts";
export const objectRecognitionConnectionInput = z.strictObject({
	expectedRevision: z.number().int().nonnegative(),
	baseUrl: cloudEndpoint.refine((v) => new URL(v).pathname === "/").optional(),
	credentialSource: z.enum(["dedicated", "larm"]).optional(),
	credential: z.string().min(16).max(4096).optional(),
});
type Row = {
	revision: number;
	base_url: string;
	credential: string;
	credential_source: "dedicated" | "larm";
};
export function objectRecognitionSettings(
	store: SqliteStore,
	encrypt: (s: string, id: string) => string,
	decrypt: (s: string, id: string) => string,
	env: Record<string, string | undefined> = {},
) {
	const get = () =>
		store.read(
			(db) =>
				db
					.query("SELECT * FROM settings_object_recognition WHERE id=1")
					.get() as Row | null,
		);
	return {
		objectRecognitionConnection() {
			const r = get();
			return {
				revision: r?.revision ?? 0,
				serviceId: "object-recognition-host",
				baseUrl: r?.base_url ?? null,
				credentialConfigured:
					!!r &&
					(r.credential_source === "larm"
						? !!resolveLarmToken(env)
						: !!r.credential),
				credentialSource: r?.credential_source ?? "dedicated",
				sharedCredentialAvailable: !!resolveLarmToken(env),
			};
		},
		/** Backend-only; not a public settings or model response. */
		objectRecognitionCredentials() {
			const r = get();
			if (!r) return null;
			const credential =
				r.credential_source === "larm"
					? resolveLarmToken(env)
					: r.credential
						? decrypt(r.credential, "object-recognition:credential")
						: undefined;
			if (!credential) return null;
			return {
				revision: r.revision,
				baseUrl: r.base_url,
				credential,
				// Private high-entropy credential fingerprint fences rotation across restarts.
				// It is never returned by the settings API or passed to a model.
				...(r.credential_source === "larm"
					? {
							credentialVersion: createHash("sha256")
								.update(credential)
								.digest("hex"),
						}
					: {}),
			};
		},
		async configureObjectRecognition(raw: unknown) {
			const parsed = objectRecognitionConnectionInput.safeParse(raw);
			if (!parsed.success)
				throw new Error("invalid_object_recognition_settings");
			const input = parsed.data;
			await store.write((db) => {
				const r = db
					.query("SELECT * FROM settings_object_recognition WHERE id=1")
					.get() as Row | null;
				if ((r?.revision ?? 0) !== input.expectedRevision)
					throw new Error("revision_conflict");
				const baseUrl = input.baseUrl ?? r?.base_url;
				if (!baseUrl)
					throw new Error("invalid_object_recognition_url_required");
				const source =
					input.credentialSource ?? r?.credential_source ?? "dedicated";
				if (source === "larm" && (input.credential || !resolveLarmToken(env)))
					throw new Error("invalid_object_recognition_shared_credential");
				if (
					source === "dedicated" &&
					(!r || r.base_url !== baseUrl || !r.credential) &&
					!input.credential
				)
					throw new Error("invalid_object_recognition_credential_required");
				const secret = input.credential
					? encrypt(input.credential, "object-recognition:credential")
					: r?.base_url === baseUrl
						? r.credential
						: "";
				db.query(
					"INSERT INTO settings_object_recognition(id,revision,base_url,credential,credential_source) VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,base_url=excluded.base_url,credential=excluded.credential,credential_source=excluded.credential_source",
				).run((r?.revision ?? 0) + 1, baseUrl, secret, source);
			});
			return this.objectRecognitionConnection();
		},
	};
}

/** Supports old settings-only test compositions without installing new tables. */
export function storedRecognitionCiphertext(store: SqliteStore): string | null {
	return store.read((db) => {
		if (
			!db
				.query(
					"SELECT 1 FROM sqlite_master WHERE name='settings_object_recognition'",
				)
				.get()
		)
			return null;
		const row = db
			.query("SELECT credential FROM settings_object_recognition WHERE id=1")
			.get() as { credential: string } | null;
		return row?.credential ?? null;
	});
}
