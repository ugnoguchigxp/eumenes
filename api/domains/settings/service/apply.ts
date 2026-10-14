import { createHash, createHmac } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
	applySchema,
	isAgentConnection,
	purposeSchema,
	type ApplySettings,
	type Connection,
	type Settings,
} from "../contracts";
import { read, save } from "../repository";
import { isAllowedEnvRef, providerKeyHosts } from "./env-ref";

/**
 * `apply` inside the caller's writer transaction (a UI action's savepoint). The caller runs
 * `notifyChanged` after the commit. `replay` is true when the request id was already saved.
 */
export function createApplyInTransaction(deps: {
	key: () => Buffer | null;
	envRefAllowlist: readonly string[];
	encrypt: (value: string, rowKey: string) => string;
	credential: (db: Database, c: Connection) => string | null;
}) {
	return function applyInTransaction(
		db: Database,
		raw: ApplySettings,
	): { settings: Settings; replay: boolean } {
		const key = deps.key();
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
		const previous = db
			.query("SELECT digest,result FROM settings_requests WHERE id=?")
			.get(input.requestId) as { digest: string; result: string } | null;
		if (previous) {
			if (previous.digest !== digest) throw new Error("request_conflict");
			return {
				settings: JSON.parse(previous.result) as Settings,
				replay: true,
			};
		}
		const old = read(db);
		if (old.revision !== input.expectedRevision)
			throw new Error("revision_conflict");
		const next = structuredClone(input.settings);
		next.revision = old.revision + 1;
		// A changed LARM origin receives the LARM token, so it needs explicit confirmation.
		const originOf = (value: string | null | undefined) =>
			value && URL.canParse(value) ? new URL(value).origin : null;
		const oldLarm = originOf(old.larm.baseUrl);
		const nextLarm = originOf(next.larm.baseUrl);
		if (
			oldLarm &&
			nextLarm &&
			oldLarm !== nextLarm &&
			input.confirmLarmOrigin !== nextLarm
		)
			throw new Error("invalid_larm_origin_unconfirmed");
		// One provider key may only be bound to a single host across all connections.
		const envHosts = new Map<string, string>();
		for (const c of next.connections) {
			if (!c.envRef || !Object.hasOwn(providerKeyHosts, c.envRef)) continue;
			const host = new URL(c.baseUrl).hostname;
			const bound = envHosts.get(c.envRef);
			if (bound && bound !== host)
				throw new Error("invalid_env_ref_host_conflict");
			envHosts.set(c.envRef, host);
		}
		if (
			new Set(input.keys.map((k) => k.connectionId)).size !== input.keys.length
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
			// A previously saved ref stays untouched (it fails on use instead).
			if (
				c.envRef &&
				(c.envRef !== prior?.envRef || c.baseUrl !== prior.baseUrl) &&
				!isAllowedEnvRef(c.envRef, deps.envRefAllowlist, c.baseUrl)
			)
				throw new Error("invalid_env_ref");
			const originChanged =
				prior && new URL(prior.baseUrl).origin !== new URL(c.baseUrl).origin;
			// A login-based agent connection (no key, no env ref) has nothing to rebind.
			const keyless =
				isAgentConnection(c) &&
				!c.envRef &&
				!prior?.envRef &&
				!db
					.query("SELECT 1 FROM settings_credentials WHERE id=?")
					.get(`${c.id}:${prior?.epoch}`);
			if (
				originChanged &&
				!mutation &&
				!keyless &&
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
					deps.encrypt(mutation.value, `${c.id}:${c.epoch}`),
				);
			else if (
				prior &&
				c.epoch !== prior.epoch &&
				!mutation &&
				!originChanged &&
				!c.envRef
			) {
				let value: string | null = null;
				try {
					value = deps.credential(db, prior);
				} catch {
					// A disallowed env ref never yields a value to copy.
				}
				if (value)
					db.query("INSERT INTO settings_credentials VALUES(?,?)").run(
						`${c.id}:${c.epoch}`,
						deps.encrypt(value, `${c.id}:${c.epoch}`),
					);
			}
		}
		for (const p of purposeSchema.options)
			next.routes[p].epoch =
				old.routes[p].epoch +
				(old.routes[p].cloudAllowed && !next.routes[p].cloudAllowed ? 1 : 0);
		// Only the current encrypted credential survives a replacement or deletion.
		// Old snapshots are fenced by their connection epoch before inference.
		const retained = new Set(
			next.connections
				.filter((c) => !c.envRef)
				.map((c) => `${c.id}:${c.epoch}`),
		);
		for (const row of db.query("SELECT id FROM settings_credentials").all() as {
			id: string;
		}[])
			if (!retained.has(row.id))
				db.query("DELETE FROM settings_credentials WHERE id=?").run(row.id);
		save(db, next);
		db.query("INSERT INTO settings_requests VALUES(?,?,?)").run(
			input.requestId,
			digest,
			JSON.stringify(next),
		);
		db.query(
			"DELETE FROM settings_requests WHERE rowid <= (SELECT max(rowid) FROM settings_requests) - 64",
		).run();
		return { settings: next, replay: false };
	};
}
