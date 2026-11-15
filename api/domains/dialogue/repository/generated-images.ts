import type { Database } from "bun:sqlite";
import type { Migration } from "../../../infrastructure/sqlite";

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

export type GeneratedImage = { uri: string; id: string; version: string };
export type ImageObservation = {
	workId: string;
	conversationId: string;
	revision: number;
	originDigest: string;
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

export function imageObservation(db: Database, workId: string) {
	const row = db
		.query("SELECT record FROM dialogue_generated_images WHERE work_id=?")
		.get(workId) as { record: string } | null;
	return row ? (JSON.parse(row.record) as ImageObservation) : null;
}

export function saveImageObservation(db: Database, record: ImageObservation) {
	db.query(
		`INSERT INTO dialogue_generated_images(work_id,conversation_id,record)
		VALUES (?,?,?) ON CONFLICT(work_id) DO UPDATE SET record=excluded.record`,
	).run(record.workId, record.conversationId, JSON.stringify(record));
}

export function recentImageObservations(db: Database, conversationId: string) {
	return (
		db
			.query(
				`SELECT record FROM dialogue_generated_images WHERE conversation_id=?
		ORDER BY rowid DESC LIMIT 4`,
			)
			.all(conversationId) as { record: string }[]
	).map((row) => JSON.parse(row.record) as ImageObservation);
}

export function deleteImageObservation(db: Database, workId: string) {
	db.query("DELETE FROM dialogue_generated_images WHERE work_id=?").run(workId);
}
