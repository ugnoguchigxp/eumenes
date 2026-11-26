import type { Database } from "bun:sqlite";
import type { Migration } from "../../../infrastructure/sqlite";

/** The first form, keyed by the TODO; dropped by `dialogue/0049-drop-retired-todos`. */
export const generatedImagesMigration: Migration = {
	id: "dialogue/0041-generated-images",
	after: ["dialogue/0040-specialist-parked"],
	sql: `CREATE TABLE dialogue_generated_images (
		work_id TEXT PRIMARY KEY REFERENCES dialogue_work(id),
		conversation_id TEXT NOT NULL,
		record TEXT NOT NULL
	);
	CREATE INDEX dialogue_generated_images_conversation
		ON dialogue_generated_images(conversation_id);`,
};

/**
 * What the model saw of the images an assignment made, keyed by the agency's work root (the `work_id` its resources
 * are entered under). The earlier table named a TODO, which no longer exists.
 */
export const assignmentImagesMigration: Migration = {
	id: "dialogue/0048-assignment-images",
	after: ["dialogue/0041-generated-images"],
	sql: `CREATE TABLE dialogue_assignment_images (
		root_id TEXT PRIMARY KEY,
		conversation_id TEXT NOT NULL,
		record TEXT NOT NULL
	);
	CREATE INDEX dialogue_assignment_images_conversation
		ON dialogue_assignment_images(conversation_id);`,
};

/** `runId`: the run the image row carries (the source run of a user's assignment, the work root for the agent's own research). */
export type GeneratedImage = {
	uri: string;
	id: string;
	version: string;
	runId?: string;
};
export type ImageObservation = {
	rootId: string;
	conversationId: string;
	images: GeneratedImage[];
	state: "pending" | "observed" | "unavailable";
	requestId?: string;
	jobId?: string;
	reason?: string;
	result?: {
		attemptId: string;
		acceptedAt: string;
		summary: string;
		inputs: Array<{
			uri: string;
			digest: string;
			mime: string;
			width: number;
			height: number;
		}>;
	};
};

export function imageObservation(db: Database, rootId: string) {
	const row = db
		.query("SELECT record FROM dialogue_assignment_images WHERE root_id=?")
		.get(rootId) as { record: string } | null;
	return row ? (JSON.parse(row.record) as ImageObservation) : null;
}

export function saveImageObservation(db: Database, record: ImageObservation) {
	db.query(
		`INSERT INTO dialogue_assignment_images(root_id,conversation_id,record)
		VALUES (?,?,?) ON CONFLICT(root_id) DO UPDATE SET record=excluded.record`,
	).run(record.rootId, record.conversationId, JSON.stringify(record));
}

export function recentImageObservations(db: Database, conversationId: string) {
	return (
		db
			.query(
				`SELECT record FROM dialogue_assignment_images WHERE conversation_id=?
		ORDER BY rowid DESC LIMIT 4`,
			)
			.all(conversationId) as { record: string }[]
	).map((row) => JSON.parse(row.record) as ImageObservation);
}

/** Whether the conversation has any image observation (the same rows `recentImageObservations` reads, as one `EXISTS`). */
export function hasImageObservations(db: Database, conversationId: string) {
	const row = db
		.query<{ present: number }, [string]>(
			"SELECT EXISTS(SELECT 1 FROM dialogue_assignment_images WHERE conversation_id=?) AS present",
		)
		.get(conversationId);
	return row?.present === 1;
}

export function deleteImageObservation(db: Database, rootId: string) {
	db.query("DELETE FROM dialogue_assignment_images WHERE root_id=?").run(
		rootId,
	);
}

/**
 * The runs an image of this conversation may be stored under besides the work root: the user's runs, newest first.
 * An image made for a user's assignment carries the run of the user's words, not the agency's work root.
 */
export function userRunIdsOfConversation(
	db: Database,
	conversationId: string,
	limit: number,
) {
	return (
		db
			.query(
				"SELECT id FROM dialogue_runs WHERE conversation_id=? AND source_kind IN ('manual','voice') ORDER BY seq DESC LIMIT ?",
			)
			.all(conversationId, limit) as Array<{ id: string }>
	).map((row) => row.id);
}

/** The image resources entered under these work roots (not forgotten), oldest number first. */
export function imageResourcesOfRoots(
	db: Database,
	conversationId: string,
	rootIds: readonly string[],
) {
	if (rootIds.length === 0) return [];
	return db
		.query(
			`SELECT work_id AS rootId, uri, created_at AS createdAt FROM dialogue_resources
			WHERE conversation_id = ? AND source = 'work' AND kind = 'image' AND forgotten_at IS NULL
				AND work_id IN (${rootIds.map(() => "?").join(",")}) ORDER BY ref`,
		)
		.all(conversationId, ...rootIds) as Array<{
		rootId: string;
		uri: string;
		createdAt: string;
	}>;
}

/** The newest assignments whose images no observation covers yet: their roots, still held by the agency. */
export function unobservedImageRoots(
	db: Database,
	conversationId: string,
	limit: number,
) {
	return (
		db
			.query(
				`SELECT r.work_id AS rootId FROM dialogue_resources r
				WHERE r.conversation_id = ? AND r.source = 'work' AND r.kind = 'image' AND r.forgotten_at IS NULL
					AND EXISTS (SELECT 1 FROM dialogue_agency_work w WHERE w.root_id = r.work_id AND w.revoked = 0)
					AND NOT EXISTS (SELECT 1 FROM dialogue_assignment_images i WHERE i.root_id = r.work_id)
				GROUP BY r.work_id ORDER BY MAX(r.ref) DESC LIMIT ?`,
			)
			.all(conversationId, limit) as Array<{ rootId: string }>
	).map((row) => row.rootId);
}

/** The observations whose assignment the agency no longer holds (forgotten): to be dropped with their model call. */
export function revokedImageRoots(db: Database, conversationId: string) {
	return (
		db
			.query(
				`SELECT i.root_id AS rootId FROM dialogue_assignment_images i
				WHERE i.conversation_id = ? AND NOT EXISTS (
					SELECT 1 FROM dialogue_agency_work w WHERE w.root_id = i.root_id AND w.revoked = 0)`,
			)
			.all(conversationId) as Array<{ rootId: string }>
	).map((row) => row.rootId);
}
