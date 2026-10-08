import {
	createCipheriv,
	createDecipheriv,
	createHash,
	createHmac,
	randomBytes,
} from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import {
	applySchema,
	purposeSchema,
	settingsSchema,
	type ApplySettings,
	type Connection,
	type Purpose,
	type Settings,
} from "../contracts";
import { read, save } from "../repository";
export function defaults(env: Record<string, string | undefined>): Settings {
	const route = () => ({
		mode: "larm-preferred" as const,
		cloudAllowed: true,
		fallbackId: null,
		epoch: 0,
	});
	return settingsSchema.parse({
		revision: 0,
		larm: {
			baseUrl: env.LARM_BASE_URL ?? null,
			profile: env.LARM_PROFILE ?? "SAAA-gemma4-26b",
			audience: env.LARM_AUDIENCE ?? "saaa-desktop",
			voice: env.EUMENES_TTS_VOICE ?? "",
		},
		connections: [],
		resources: [],
		routes: { llm: route(), asr: route(), tts: route() },
		voice: {
			autoSpeak: true,
			bargeIn: true,
			inputDevice: "",
			outputDevice: "",
			threshold: 0.008,
			silenceMs: 700,
			echoCancellation: true,
			noiseSuppression: true,
			autoGainControl: true,
		},
		general: { theme: "system" },
	});
}
export async function createSettings(
	store: SqliteStore,
	options: { dbPath: string; env?: Record<string, string | undefined> },
) {
	const env = options.env ?? process.env;
	let key: Buffer | null = null;
	let keyError: string | null = null;
	const path = join(dirname(options.dbPath), "keys", "settings.key");
	try {
		if (env.EUMENES_SECRET_KEY)
			key = Buffer.from(env.EUMENES_SECRET_KEY, "base64");
		else if (existsSync(path)) key = readFileSync(path);
		else if (
			store.read(
				(db) =>
					(
						db
							.query("SELECT count(*) AS n FROM settings_credentials")
							.get() as { n: number }
					).n,
			) > 0
		)
			throw new Error("secret_key_missing");
		else {
			mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
			chmodSync(dirname(path), 0o700);
			key = randomBytes(32);
			writeFileSync(path, key, { mode: 0o600, flag: "wx" });
		}
		if (key.length !== 32) throw new Error("secret_key_invalid");
		// Verify existing ciphertext before accepting a replacement master key.
		for (const row of store.read(
			(db) =>
				db.query("SELECT encrypted FROM settings_credentials").all() as {
					encrypted: string;
				}[],
		))
			decrypt(row.encrypted);
	} catch {
		key = null;
		keyError = "secret_key_unavailable";
	}
	function encrypt(value: string) {
		if (!key) throw new Error("invalid_secret_key_unavailable");
		const iv = randomBytes(12);
		const c = createCipheriv("aes-256-gcm", key, iv);
		const bytes = Buffer.concat([c.update(value, "utf8"), c.final()]);
		return [iv, c.getAuthTag(), bytes]
			.map((b) => b.toString("base64"))
			.join(".");
	}
	function decrypt(value: string) {
		if (!key) throw new Error("secret_key_unavailable");
		const [iv, tag, bytes] = value
			.split(".")
			.map((s) => Buffer.from(s, "base64"));
		if (!iv || !tag || !bytes) throw new Error("secret_invalid");
		const c = createDecipheriv("aes-256-gcm", key, iv);
		c.setAuthTag(tag);
		return Buffer.concat([c.update(bytes), c.final()]).toString("utf8");
	}
	await store.write((db) => {
		if (!db.query("SELECT id FROM settings_document").get())
			save(db, defaults(env));
	});
	const listeners = new Set<() => void>();
	function credential(db: Database, c: Connection): string | null {
		if (c.envRef) return env[c.envRef]?.trim() || null;
		if (!key) return null;
		const row = db
			.query("SELECT encrypted FROM settings_credentials WHERE id=?")
			.get(`${c.id}:${c.epoch}`) as { encrypted: string } | null;
		return row ? decrypt(row.encrypted) : null;
	}
	return {
		get: () => store.read(read),
		inTransaction: read,
		credential: (c: Connection) => store.read((db) => credential(db, c)),
		diagnostics: () =>
			store.read((db) => ({
				version: 1,
				revision: read(db).revision,
				routes: Object.fromEntries(
					purposeSchema.options.map((p) => [
						p,
						{
							mode: read(db).routes[p].mode,
							cloudAllowed: read(db).routes[p].cloudAllowed,
							fallbackRegistered: !!read(db).routes[p].fallbackId,
						},
					]),
				),
				keyError,
				connections: read(db).connections.map((c) => ({
					id: c.id,
					enabled: c.enabled,
					credentialAvailable: !!credential(db, c),
					source: c.envRef ? "environment" : "encrypted",
				})),
			})),
		onChange(fn: () => void) {
			listeners.add(fn);
			return () => {
				listeners.delete(fn);
			};
		},
		valid(
			db: Database,
			snapshot: Settings,
			purpose: Purpose,
			connection?: Connection,
		) {
			const current = read(db);
			const before = snapshot.routes[purpose];
			const after = current.routes[purpose];
			if (
				connection &&
				(!after.cloudAllowed ||
					after.epoch !== before.epoch ||
					!current.connections.some(
						(c) =>
							c.id === connection.id &&
							c.enabled &&
							c.epoch === connection.epoch,
					))
			)
				return false;
			return true;
		},
		async apply(raw: ApplySettings) {
			const input = applySchema.parse(raw);
			if (input.keys.some((k) => k.value) && !key)
				throw new Error("invalid_secret_key_unavailable");
			const digest = (
				input.keys.some((k) => k.value)
					? createHmac("sha256", key!)
					: createHash("sha256")
			)
				.update(JSON.stringify(input))
				.digest("hex");
			const result = await store.write((db) => {
				const previous = db
					.query("SELECT digest,result FROM settings_requests WHERE id=?")
					.get(input.requestId) as { digest: string; result: string } | null;
				if (previous) {
					if (previous.digest !== digest) throw new Error("request_conflict");
					return JSON.parse(previous.result) as Settings;
				}
				const old = read(db);
				if (old.revision !== input.expectedRevision)
					throw new Error("revision_conflict");
				const next = structuredClone(input.settings);
				next.revision = old.revision + 1;
				if (
					new Set(input.keys.map((k) => k.connectionId)).size !==
					input.keys.length
				)
					throw new Error("invalid_duplicate_key");
				for (const k of input.keys)
					if (!next.connections.some((c) => c.id === k.connectionId))
						throw new Error("invalid_key_connection");
				for (const c of old.connections)
					if (!next.connections.some((n) => n.id === c.id))
						db.query(
							"INSERT INTO settings_connection_epochs VALUES(?,?) ON CONFLICT(id) DO UPDATE SET epoch=MAX(epoch,excluded.epoch)",
						).run(c.id, c.epoch + 1);
				for (const c of next.connections) {
					const prior = old.connections.find((x) => x.id === c.id);
					const mutation = input.keys.find((k) => k.connectionId === c.id);
					const originChanged =
						prior &&
						new URL(prior.baseUrl).origin !== new URL(c.baseUrl).origin;
					if (
						originChanged &&
						!mutation &&
						(!c.envRef || c.envRef === prior?.envRef)
					)
						throw new Error("invalid_origin_requires_new_key");
					const revoked =
						prior &&
						((prior.enabled && !c.enabled) ||
							prior.envRef !== c.envRef ||
							originChanged);
					const epochRow = db
						.query("SELECT epoch FROM settings_connection_epochs WHERE id=?")
						.get(c.id) as { epoch: number } | null;
					c.epoch =
						Math.max(prior?.epoch ?? 0, epochRow?.epoch ?? 0) +
						(mutation || revoked ? 1 : 0);
					db.query(
						"INSERT INTO settings_connection_epochs VALUES(?,?) ON CONFLICT(id) DO UPDATE SET epoch=excluded.epoch",
					).run(c.id, c.epoch);
					if (mutation && mutation.value === null) c.envRef = null;
					if (mutation?.value && c.envRef)
						throw new Error("invalid_credential_source");
					if (mutation?.value)
						db.query("INSERT INTO settings_credentials VALUES(?,?)").run(
							`${c.id}:${c.epoch}`,
							encrypt(mutation.value),
						);
					else if (
						prior &&
						c.epoch !== prior.epoch &&
						!mutation &&
						!originChanged &&
						!c.envRef
					) {
						const value = credential(db, prior);
						if (value)
							db.query("INSERT INTO settings_credentials VALUES(?,?)").run(
								`${c.id}:${c.epoch}`,
								encrypt(value),
							);
					}
				}
				for (const p of purposeSchema.options)
					next.routes[p].epoch =
						old.routes[p].epoch +
						(old.routes[p].cloudAllowed && !next.routes[p].cloudAllowed
							? 1
							: 0);
				save(db, next);
				db.query("INSERT INTO settings_requests VALUES(?,?,?)").run(
					input.requestId,
					digest,
					JSON.stringify(next),
				);
				return next;
			});
			for (const fn of listeners) fn();
			return result;
		},
	};
}
export type SettingsService = Awaited<ReturnType<typeof createSettings>>;
