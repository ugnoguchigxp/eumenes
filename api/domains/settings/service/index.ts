import { doclingSettings } from "./docling";
import {
	browserBridgeSettings,
	storedBridgeCiphertext,
} from "./browser-bridge";
import { ocrSettings } from "./ocr";
import {
	objectRecognitionSettings,
	storedRecognitionCiphertext,
} from "./object-recognition";
import {
	localServiceSettings,
	storedLocalServiceCiphertexts,
} from "./local-services";
import { validSettings } from "./valid";
import { createApplyInTransaction } from "./apply";
import { isAllowedEnvRef } from "./env-ref";
export { isAllowedEnvRef };
import {
	createCipheriv,
	createDecipheriv,
	createHmac,
	randomBytes,
} from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Database } from "bun:sqlite";
import { createFileExclusive } from "../../../infrastructure/atomic-file";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import {
	defaultSubtitles,
	purposeSchema,
	settingsSchema,
	type ApplySettings,
	type Connection,
	type Settings,
} from "../contracts";
import { persistStoredMigration, read, save } from "../repository";
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
			baseUrl: null,
			profile: env.LARM_PROFILE?.trim() || undefined,
			audience: env.LARM_AUDIENCE ?? "saaa-desktop",
			voice: env.EUMENES_TTS_VOICE ?? "",
			speed: 1,
		},
		connections: [],
		resources: [],
		routes: { llm: route(), asr: route(), tts: route() },
		voice: {
			autoSpeak: true,
			outputVolume: 1,
			bargeIn: true,
			inputDevice: "",
			outputDevice: "",
			threshold: 0.008,
			silenceMs: 1500,
			echoCancellation: true,
			noiseSuppression: true,
			autoGainControl: true,
		},
		general: {
			agentName: "",
			userName: "",
			persona: "butler",
			asrLanguages: ["ja", "en"],
			theme: "system",
			background: "light-fairy",
			subtitles: defaultSubtitles,
		},
		codingSupervision: { approveInstructions: true },
		world: { enabled: false },
	});
}
export async function createSettings(
	store: SqliteStore,
	options: {
		dbPath: string;
		env?: Record<string, string | undefined>;
		/** Directory holding the master key. Defaults to EUMENES_KEY_DIR, then <dbDir>/keys. */
		keyDir?: string;
	},
) {
	const env = options.env ?? {};
	const envRefAllowlist = (env.EUMENES_ENV_REF_ALLOWLIST ?? "")
		.split(",")
		.map((v) => v.trim())
		.filter(Boolean);
	const recognitionCiphertext = storedRecognitionCiphertext(store);
	const bridgeCiphertext = storedBridgeCiphertext(store);
	const localServiceCiphertexts = storedLocalServiceCiphertexts(store);
	let key: Buffer | null = null;
	let keyError: string | null = null;
	const keyDir =
		options.keyDir ||
		env.EUMENES_KEY_DIR?.trim() ||
		join(dirname(options.dbPath), "keys");
	const path = join(keyDir, "settings.key");
	try {
		if (env.EUMENES_SECRET_KEY)
			key = Buffer.from(env.EUMENES_SECRET_KEY, "base64");
		else if (existsSync(path)) key = readFileSync(path);
		else if (
			bridgeCiphertext ||
			localServiceCiphertexts.length > 0 ||
			recognitionCiphertext ||
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
			// A concurrent creator won the race: use the key it wrote.
			if (!createFileExclusive(path, key)) key = readFileSync(path);
		}
		if (key.length !== 32) throw new Error("secret_key_invalid");
		if (bridgeCiphertext) decrypt(bridgeCiphertext, "browser:bridge");
		if (recognitionCiphertext)
			decrypt(recognitionCiphertext, "object-recognition:credential");
		for (const row of localServiceCiphertexts) decrypt(row.encrypted, row.id);
		// Verify existing ciphertext before accepting a replacement master key.
		const upgraded: { id: string; encrypted: string }[] = [];
		for (const row of store.read(
			(db) =>
				db.query("SELECT id, encrypted FROM settings_credentials").all() as {
					id: string;
					encrypted: string;
				}[],
		)) {
			const plain = decrypt(row.encrypted, row.id);
			// v1 ciphertext has no AAD; rebind it to its row in one transaction.
			if (!row.encrypted.startsWith("v2."))
				upgraded.push({ id: row.id, encrypted: encrypt(plain, row.id) });
		}
		if (upgraded.length)
			await store.write((db) => {
				for (const row of upgraded)
					db.query(
						"UPDATE settings_credentials SET encrypted=? WHERE id=?",
					).run(row.encrypted, row.id);
			});
	} catch {
		key = null;
		keyError = "secret_key_unavailable";
	}
	/** v2.<iv>.<tag>.<bytes>, authenticated against the credential row it belongs to. */
	function encrypt(value: string, rowKey: string) {
		if (!key) throw new Error("invalid_secret_key_unavailable");
		const iv = randomBytes(12);
		const c = createCipheriv("aes-256-gcm", key, iv);
		c.setAAD(Buffer.from(`eumenes:settings:v2:${rowKey}`));
		const bytes = Buffer.concat([c.update(value, "utf8"), c.final()]);
		return [
			"v2",
			...[iv, c.getAuthTag(), bytes].map((b) => b.toString("base64")),
		].join(".");
	}
	function decrypt(value: string, rowKey: string) {
		if (!key) throw new Error("secret_key_unavailable");
		const parts = value.split(".");
		const v2 = parts[0] === "v2";
		const [iv, tag, bytes] = (v2 ? parts.slice(1) : parts).map((s) =>
			Buffer.from(s, "base64"),
		);
		if (!iv || !tag || !bytes) throw new Error("secret_invalid");
		const c = createDecipheriv("aes-256-gcm", key, iv);
		if (v2) c.setAAD(Buffer.from(`eumenes:settings:v2:${rowKey}`));
		c.setAuthTag(tag);
		return Buffer.concat([c.update(bytes), c.final()]).toString("utf8");
	}
	await store.write((db) => {
		if (!db.query("SELECT id FROM settings_document").get())
			save(db, defaults(env));
		else persistStoredMigration(db);
	});
	const listeners = new Set<() => void>();
	function credential(db: Database, c: Connection): string | null {
		if (c.envRef) {
			if (!isAllowedEnvRef(c.envRef, envRefAllowlist, c.baseUrl))
				throw new Error("env_ref_not_allowed");
			return env[c.envRef]?.trim() || null;
		}
		if (!key) return null;
		const row = db
			.query("SELECT encrypted FROM settings_credentials WHERE id=?")
			.get(`${c.id}:${c.epoch}`) as { encrypted: string } | null;
		return row ? decrypt(row.encrypted, `${c.id}:${c.epoch}`) : null;
	}
	const applyInTransaction = createApplyInTransaction({
		key: () => key,
		envRefAllowlist,
		encrypt,
		credential,
	});
	function notifyChanged() {
		for (const fn of listeners) fn();
	}
	return {
		/**
		 * A key derived from the master key for one purpose (e.g. HMAC digests of secret-bearing
		 * requests). The master key itself never leaves this domain; undefined when unavailable.
		 */
		derivedKey(purpose: string): Uint8Array | undefined {
			return key
				? new Uint8Array(
						createHmac("sha256", key)
							.update(`eumenes:settings:derived:${purpose}`)
							.digest(),
					)
				: undefined;
		},
		...browserBridgeSettings(store, encrypt, decrypt, () => key !== null),
		...localServiceSettings(store, encrypt, decrypt),
		...objectRecognitionSettings(store, encrypt, decrypt, env),
		...ocrSettings(store, env),
		...doclingSettings(store, env),
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
					credentialAvailable: (() => {
						try {
							return !!credential(db, c);
						} catch {
							return false;
						}
					})(),
					source: c.envRef ? "environment" : "encrypted",
				})),
			})),
		onChange(fn: () => void) {
			listeners.add(fn);
			return () => {
				listeners.delete(fn);
			};
		},
		valid: validSettings,
		applyInTransaction,
		notifyChanged,
		/** Idempotent replay is guaranteed only for the newest 64 requests. */
		async apply(raw: ApplySettings) {
			const result = await store.write((db) => applyInTransaction(db, raw));
			notifyChanged();
			return result.settings;
		},
	};
}
export type SettingsService = Awaited<ReturnType<typeof createSettings>>;
