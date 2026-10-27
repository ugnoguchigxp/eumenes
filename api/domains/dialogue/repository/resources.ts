import type { Database } from "bun:sqlite";
import type {
	ConversationResource,
	ConversationResourceSource,
	WorkLink,
} from "../contracts/resources";

/**
 * The conversation's resource ledger (spec resource-uri-implementation-plan-2026-10-25.md section 4.2): every
 * resource the conversation has met, numbered `a<ref>` per conversation and never renumbered; and the resources each
 * message shows as chips.
 */
export const resourcesMigration = `
CREATE TABLE dialogue_resources (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, ref INTEGER NOT NULL,
 uri TEXT NOT NULL, kind TEXT NOT NULL, label TEXT NOT NULL,
 source TEXT NOT NULL CHECK(source IN ('work','found','viewed')), work_id TEXT,
 used_at TEXT NOT NULL, created_at TEXT NOT NULL, forgotten_at TEXT,
 UNIQUE(conversation_id, ref), UNIQUE(conversation_id, uri));
CREATE INDEX dialogue_resources_used ON dialogue_resources(conversation_id, forgotten_at, used_at);
CREATE INDEX dialogue_resources_work ON dialogue_resources(work_id);
CREATE TABLE dialogue_message_resources (
 message_id TEXT NOT NULL, resource_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
 PRIMARY KEY(message_id, ordinal), UNIQUE(message_id, resource_id));
CREATE INDEX dialogue_message_resources_resource ON dialogue_message_resources(resource_id);`;

/** What a finished TODO made (section 4.1): the links stay with the TODO, as `[{uri, kind, label}]`. */
export const workLinksMigration = `ALTER TABLE dialogue_work ADD COLUMN links_json TEXT NOT NULL DEFAULT '[]';`;

/** The resources a confirmation was issued with (`delegate` `refs`): approving it hands them over as they were named. */
export const confirmationRefsMigration = `ALTER TABLE dialogue_confirmations ADD COLUMN refs_json TEXT NOT NULL DEFAULT '[]';`;

/** The resource the run's screen showed (its URI); apart from the specialist's `viewing_json`, which readers shape-check. */
export const runViewingResourceMigration = `ALTER TABLE dialogue_runs ADD COLUMN viewing_resource TEXT;`;

const columns =
	"id, conversation_id, ref, uri, kind, label, source, work_id, used_at, created_at, forgotten_at";

function map(row: Record<string, unknown>): ConversationResource {
	return {
		id: row.id as string,
		conversationId: row.conversation_id as string,
		ref: row.ref as number,
		uri: row.uri as string,
		kind: row.kind as string,
		label: row.label as string,
		source: row.source as ConversationResourceSource,
		workId: (row.work_id as string | null) ?? null,
		usedAt: row.used_at as string,
		createdAt: row.created_at as string,
		forgottenAt: (row.forgotten_at as string | null) ?? null,
	};
}

export function resourceByUri(
	db: Database,
	conversationId: string,
	uri: string,
): ConversationResource | null {
	const row = db
		.query(
			`SELECT ${columns} FROM dialogue_resources WHERE conversation_id = ? AND uri = ?`,
		)
		.get(conversationId, uri);
	return row ? map(row as Record<string, unknown>) : null;
}

export function resourceById(
	db: Database,
	id: string,
): ConversationResource | null {
	const row = db
		.query(`SELECT ${columns} FROM dialogue_resources WHERE id = ?`)
		.get(id);
	return row ? map(row as Record<string, unknown>) : null;
}

/** The resource the model names `a<ref>`; a forgotten one is not found. */
export function resourceByRef(
	db: Database,
	conversationId: string,
	ref: number,
): ConversationResource | null {
	const row = db
		.query(
			`SELECT ${columns} FROM dialogue_resources WHERE conversation_id = ? AND ref = ? AND forgotten_at IS NULL`,
		)
		.get(conversationId, ref);
	return row ? map(row as Record<string, unknown>) : null;
}

export function insertResource(
	db: Database,
	row: Omit<ConversationResource, "ref" | "forgottenAt" | "workId"> & {
		workId: string | null;
	},
): ConversationResource {
	db.query(
		`INSERT INTO dialogue_resources (id, conversation_id, ref, uri, kind, label, source, work_id, used_at, created_at)
 VALUES (?, ?, (SELECT COALESCE(MAX(ref), 0) + 1 FROM dialogue_resources WHERE conversation_id = ?), ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		row.id,
		row.conversationId,
		row.conversationId,
		row.uri,
		row.kind,
		row.label,
		row.source,
		row.workId,
		row.usedAt,
		row.createdAt,
	);
	return resourceById(db, row.id)!;
}

/** A known resource met again: used now, shown again if it was forgotten, its origin and label kept current. */
export function reenterResource(
	db: Database,
	id: string,
	patch: {
		label: string;
		source: ConversationResourceSource;
		workId: string | null;
		usedAt: string;
	},
) {
	db.query(
		"UPDATE dialogue_resources SET label = ?, source = ?, work_id = ?, used_at = ?, forgotten_at = NULL WHERE id = ?",
	).run(patch.label, patch.source, patch.workId, patch.usedAt, id);
}

export function touchResource(db: Database, id: string, at: string) {
	db.query("UPDATE dialogue_resources SET used_at = ? WHERE id = ?").run(
		at,
		id,
	);
}

/** The resources not forgotten, most recently used first (ties: the higher number first). */
export function usedResources(
	db: Database,
	conversationId: string,
	limit: number,
): ConversationResource[] {
	return (
		db
			.query(
				`SELECT ${columns} FROM dialogue_resources WHERE conversation_id = ? AND forgotten_at IS NULL ORDER BY used_at DESC, ref DESC LIMIT ?`,
			)
			.all(conversationId, limit) as Record<string, unknown>[]
	).map(map);
}

/** Every resource of the conversation, forgotten ones included, in number order. */
export function allResources(
	db: Database,
	conversationId: string,
): ConversationResource[] {
	return (
		db
			.query(
				`SELECT ${columns} FROM dialogue_resources WHERE conversation_id = ? ORDER BY ref`,
			)
			.all(conversationId) as Record<string, unknown>[]
	).map(map);
}

/** Links resources to a message after the ones it already has; a resource already linked keeps its place. */
export function linkMessageResources(
	db: Database,
	messageId: string,
	resourceIds: readonly string[],
) {
	for (const resourceId of resourceIds)
		db.query(
			`INSERT OR IGNORE INTO dialogue_message_resources (message_id, resource_id, ordinal)
 VALUES (?, ?, (SELECT COALESCE(MAX(ordinal), -1) + 1 FROM dialogue_message_resources WHERE message_id = ?))`,
		).run(messageId, resourceId, messageId);
}

/** The resources one message links, in link order (forgotten ones included; the caller skips them). */
export function resourcesOfMessage(
	db: Database,
	messageId: string,
): ConversationResource[] {
	return (
		db
			.query(
				`SELECT ${columns
					.split(", ")
					.map((c) => `r.${c}`)
					.join(", ")} FROM dialogue_message_resources mr
 JOIN dialogue_resources r ON r.id = mr.resource_id WHERE mr.message_id = ? ORDER BY mr.ordinal`,
			)
			.all(messageId) as Record<string, unknown>[]
	).map(map);
}

/** The URIs each message of the conversation links, in link order. */
export function messageResourceUris(
	db: Database,
	conversationId: string,
): Array<{ messageId: string; uri: string }> {
	return (
		db
			.query(
				`SELECT mr.message_id AS messageId, r.uri AS uri FROM dialogue_message_resources mr
 JOIN dialogue_resources r ON r.id = mr.resource_id
 WHERE r.conversation_id = ? ORDER BY mr.message_id, mr.ordinal`,
			)
			.all(conversationId) as Array<{ messageId: string; uri: string }>
	).map((row) => ({ messageId: row.messageId, uri: row.uri }));
}

function parseLinks(text: unknown): WorkLink[] {
	try {
		const value = JSON.parse(String(text ?? "[]")) as unknown;
		return Array.isArray(value) ? (value as WorkLink[]) : [];
	} catch {
		return [];
	}
}

/** The links of these TODOs (`links_json`), by TODO id. */
export function workLinksOf(
	db: Database,
	workIds: readonly string[],
): Map<string, WorkLink[]> {
	const links = new Map<string, WorkLink[]>();
	if (workIds.length === 0) return links;
	const rows = db
		.query(
			`SELECT id, links_json FROM dialogue_work WHERE id IN (${workIds.map(() => "?").join(",")})`,
		)
		.all(...workIds) as Array<{ id: string; links_json: string }>;
	for (const row of rows) {
		const parsed = parseLinks(row.links_json);
		if (parsed.length) links.set(row.id, parsed);
	}
	return links;
}

export function setWorkLinks(
	db: Database,
	workId: string,
	links: readonly WorkLink[],
) {
	db.query("UPDATE dialogue_work SET links_json = ? WHERE id = ?").run(
		JSON.stringify(links),
		workId,
	);
}

/**
 * Forgetting reaches the resources of the TODOs that came from a forgotten message (section 4.2): the TODOs' links
 * are emptied and the resources they made are no longer shown (the number stays taken).
 */
export function forgetWorkResources(
	db: Database,
	works: ReadonlyArray<{ id: string }>,
	at: string,
) {
	for (const { id: workId } of works) {
		db.query("UPDATE dialogue_work SET links_json = '[]' WHERE id = ?").run(
			workId,
		);
		db.query(
			"UPDATE dialogue_resources SET forgotten_at = COALESCE(forgotten_at, ?) WHERE work_id = ? AND source = 'work'",
		).run(at, workId);
	}
}

export function saveConfirmationRefs(
	db: Database,
	confirmationId: string,
	uris: readonly string[],
) {
	db.query("UPDATE dialogue_confirmations SET refs_json = ? WHERE id = ?").run(
		JSON.stringify(uris),
		confirmationId,
	);
}

/** The resource URIs a confirmation was issued with. */
export function confirmationResourceUris(
	db: Database,
	confirmationId: string,
): string[] {
	const row = db
		.query("SELECT refs_json FROM dialogue_confirmations WHERE id = ?")
		.get(confirmationId) as { refs_json: string } | null;
	try {
		const value = JSON.parse(row?.refs_json ?? "[]") as unknown;
		return Array.isArray(value)
			? value.filter((item): item is string => typeof item === "string")
			: [];
	} catch {
		return [];
	}
}

export function setRunViewingResource(
	db: Database,
	runId: string,
	uri: string,
) {
	db.query("UPDATE dialogue_runs SET viewing_resource = ? WHERE id = ?").run(
		uri,
		runId,
	);
}

/** The URI of the resource the run's screen showed, or null. */
export function runViewingResource(db: Database, runId: string): string | null {
	const row = db
		.query("SELECT viewing_resource FROM dialogue_runs WHERE id = ?")
		.get(runId) as { viewing_resource: string | null } | null;
	return row?.viewing_resource ?? null;
}
