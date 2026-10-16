import type { Database } from "bun:sqlite";
import { settingsSchema } from "../contracts";

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
	typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * One-time migration of a stored settings document, applied before the strict parse:
 * - Managed Agents connections (a removed kind) go with their models; routes and the dedicated
 *   World / sub-agent models that pointed at them fall back to LARM.
 * - Claude Agent SDK connections get the explicit `auth` the key used to imply
 *   (a stored key or an env ref: "api-key"; nothing: "subscription").
 * - The removed Managed Agents fields are dropped.
 * - The LARM sentence-language switch becomes `englishSpeechEnabled`; its classifier selector is dropped.
 * - The removed ASR language allow-list is dropped (transcripts are no longer language-gated).
 * It is idempotent: a migrated document passes through unchanged.
 */
export function migrateStoredSettings(
	db: Database,
	raw: unknown,
): { document: unknown; removedConnectionIds: string[] } {
	if (isObject(raw) && isObject(raw.larm)) {
		const {
			sentenceLanguageEnabled,
			sentenceLanguageProvider: _provider,
			...larm
		} = raw.larm;
		if (sentenceLanguageEnabled !== undefined)
			larm.englishSpeechEnabled ??= sentenceLanguageEnabled;
		raw = { ...raw, larm };
	}
	if (isObject(raw) && isObject(raw.general) && "asrLanguages" in raw.general) {
		const { asrLanguages: _languages, ...general } = raw.general;
		raw = { ...raw, general };
	}
	if (!isObject(raw) || !Array.isArray(raw.connections))
		return { document: raw, removedConnectionIds: [] };
	const hasCredential = (c: Json) =>
		!!db
			.query("SELECT 1 FROM settings_credentials WHERE id=?")
			.get(`${String(c.id)}:${String(c.epoch)}`);
	const removed = new Set<string>();
	const connections: unknown[] = [];
	for (const c of raw.connections) {
		if (!isObject(c)) {
			connections.push(c);
			continue;
		}
		if (c.kind === "claude-managed-agents") {
			removed.add(String(c.id));
			continue;
		}
		const { agentId: _agentId, environmentId: _environmentId, ...rest } = c;
		if (rest.kind === "claude-agent-sdk" && rest.auth === undefined)
			rest.auth =
				rest.envRef || hasCredential(rest) ? "api-key" : "subscription";
		connections.push(rest);
	}
	const out: Json = { ...raw, connections };
	if (removed.size === 0) return { document: out, removedConnectionIds: [] };
	const removedResources = new Set<string>();
	if (Array.isArray(raw.resources))
		out.resources = raw.resources.filter((r) => {
			const drop = isObject(r) && removed.has(String(r.connectionId));
			if (drop) removedResources.add(String((r as Json).id));
			return !drop;
		});
	if (isObject(raw.routes))
		out.routes = Object.fromEntries(
			Object.entries(raw.routes).map(([purpose, route]) => {
				if (!isObject(route) || !removedResources.has(String(route.fallbackId)))
					return [purpose, route];
				return [
					purpose,
					{
						...route,
						fallbackId: null,
						mode: route.mode === "cloud-only" ? "larm-preferred" : route.mode,
					},
				];
			}),
		);
	for (const key of ["world", "subagent"] as const) {
		const section = raw[key];
		const field = key === "world" ? "curationResourceId" : "resourceId";
		if (isObject(section) && removedResources.has(String(section[field])))
			out[key] = { ...section, [field]: null };
	}
	return { document: out, removedConnectionIds: [...removed] };
}

/**
 * Persists the migration at startup: the normalized document is saved and the credentials of the
 * removed connections are deleted (their epochs are raised so an in-flight snapshot is fenced).
 * A migrated document that still does not fit the schema fails here, loudly, instead of being saved.
 */
export function persistStoredMigration(db: Database) {
	const row = db
		.query("SELECT document FROM settings_document WHERE id=1")
		.get() as { document: string } | null;
	if (!row) return;
	const before = JSON.parse(row.document) as unknown;
	const { document, removedConnectionIds } = migrateStoredSettings(db, before);
	if (JSON.stringify(document) === JSON.stringify(before)) return;
	db.query("UPDATE settings_document SET document=? WHERE id=1").run(
		JSON.stringify(settingsSchema.parse(document)),
	);
	for (const id of removedConnectionIds) {
		const epoch = (before as { connections: Json[] }).connections.find(
			(c) => c.id === id,
		)?.epoch;
		db.query("DELETE FROM settings_credentials WHERE id LIKE ?").run(`${id}:%`);
		db.query(
			"INSERT INTO settings_connection_epochs VALUES(?,?) ON CONFLICT(id) DO UPDATE SET epoch=MAX(epoch,excluded.epoch)",
		).run(id, (typeof epoch === "number" ? epoch : 0) + 1);
	}
}
