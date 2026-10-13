import type { SqliteStore } from "../../../infrastructure/sqlite";
import { excalidrawConnectionInput } from "../contracts/local-services";
type Row = {
	revision: number;
	gateway_url: string;
	gateway_origin: string;
	lease_endpoint: string;
	consumer: string;
	app: string;
};
export function localServiceSettings(
	store: SqliteStore,
	encrypt: (s: string, id: string) => string,
	decrypt: (s: string, id: string) => string,
) {
	const row = () =>
		store.read(
			(db) =>
				db
					.query("SELECT * FROM settings_excalidraw WHERE id=1")
					.get() as Row | null,
		);
	return {
		excalidrawConnection() {
			const r = row();
			return r
				? {
						revision: r.revision,
						gatewayUrl: r.gateway_url,
						gatewayOrigin: r.gateway_origin,
						leaseEndpoint: r.lease_endpoint,
						consumerConfigured: !!r.consumer,
						appConfigured: !!r.app,
					}
				: {
						revision: 0,
						gatewayUrl: null,
						gatewayOrigin: null,
						leaseEndpoint: null,
						consumerConfigured: false,
						appConfigured: false,
					};
		},
		/** Backend-only. Credentials never appear in get/diagnostics responses. */
		excalidrawCredentials() {
			const r = row();
			if (!r) return null;
			return {
				revision: r.revision,
				gatewayUrl: r.gateway_url,
				gatewayOrigin: r.gateway_origin,
				leaseEndpoint: r.lease_endpoint,
				consumerToken: decrypt(r.consumer, "excalidraw:consumer"),
				appToken: decrypt(r.app, "excalidraw:app"),
			};
		},
		async configureExcalidraw(raw: unknown) {
			const input = excalidrawConnectionInput.parse(raw);
			await store.write((db) => {
				const r = db
					.query("SELECT * FROM settings_excalidraw WHERE id=1")
					.get() as Row | null;
				const gatewayOrigin =
					input.gatewayOrigin ??
					(r?.gateway_url === input.gatewayUrl
						? r.gateway_origin
						: input.gatewayUrl);
				if ((r?.revision ?? 0) !== input.expectedRevision)
					throw new Error("conflict_excalidraw_settings");
				if (
					(!r ||
						r.gateway_url !== input.gatewayUrl ||
						r.gateway_origin !== gatewayOrigin ||
						r.lease_endpoint !== input.leaseEndpoint) &&
					(!input.consumerToken || !input.appToken)
				)
					throw new Error("invalid_excalidraw_credentials_required");
				const consumer = input.consumerToken
					? encrypt(input.consumerToken, "excalidraw:consumer")
					: r!.consumer;
				const app = input.appToken
					? encrypt(input.appToken, "excalidraw:app")
					: r!.app;
				// Distinct roles are mandatory; never repurpose an LLM/control credential.
				const c =
					input.consumerToken ?? decrypt(consumer, "excalidraw:consumer");
				const a = input.appToken ?? decrypt(app, "excalidraw:app");
				if (c === a) throw new Error("invalid_excalidraw_credential_roles");
				db.query(
					"INSERT INTO settings_excalidraw VALUES(1,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,gateway_url=excluded.gateway_url,gateway_origin=excluded.gateway_origin,lease_endpoint=excluded.lease_endpoint,consumer=excluded.consumer,app=excluded.app",
				).run(
					(r?.revision ?? 0) + 1,
					input.gatewayUrl,
					gatewayOrigin,
					input.leaseEndpoint,
					consumer,
					app,
				);
			});
			return this.excalidrawConnection();
		},
	};
}

/** Include these role-bound ciphertexts when validating or recovering the common master key. */
export function storedLocalServiceCiphertexts(store: SqliteStore) {
	return store.read((db) => {
		if (
			!db
				.query("SELECT 1 FROM sqlite_master WHERE name='settings_excalidraw'")
				.get()
		)
			return [];
		const row = db
			.query("SELECT consumer,app FROM settings_excalidraw WHERE id=1")
			.get() as { consumer: string; app: string } | null;
		return row
			? [
					{ id: "excalidraw:consumer", encrypted: row.consumer },
					{ id: "excalidraw:app", encrypted: row.app },
				]
			: [];
	});
}
