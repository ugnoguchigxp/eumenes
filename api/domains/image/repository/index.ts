import type { Database } from "bun:sqlite";
import type { Migration } from "../../../infrastructure/sqlite";
import type { ImageRecord } from "../contracts";
export const migrations: readonly Migration[] = [
	{
		id: "image/0001-init",
		after: ["queue/0001-init"],
		sql: `
CREATE TABLE image_generations (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE, conversation_id TEXT NOT NULL,
 record_json TEXT NOT NULL, request_json TEXT NOT NULL, plan_json TEXT, bindings_json TEXT NOT NULL,
 deadline INTEGER NOT NULL, queue_job_id TEXT
);
CREATE INDEX image_conversation ON image_generations(conversation_id);
`,
	},
	{
		id: "image/0002-imports",
		after: ["image/0001-init"],
		sql: `CREATE TABLE image_imports (
 request_id TEXT PRIMARY KEY, principal TEXT NOT NULL, connection TEXT NOT NULL,
 original_digest TEXT NOT NULL, bytes BLOB, attempted INTEGER NOT NULL DEFAULT 0,
 view_json TEXT NOT NULL, expires_at INTEGER NOT NULL
);`,
	},
	{
		id: "image/0003-execution-calls",
		after: ["image/0002-imports"],
		sql: `
CREATE TABLE image_generations_next (id TEXT PRIMARY KEY,run_id TEXT NOT NULL,conversation_id TEXT NOT NULL,record_json TEXT NOT NULL,request_json TEXT NOT NULL,plan_json TEXT,bindings_json TEXT NOT NULL,deadline INTEGER NOT NULL,queue_job_id TEXT);
INSERT INTO image_generations_next SELECT * FROM image_generations;
DROP TABLE image_generations;
ALTER TABLE image_generations_next RENAME TO image_generations;
CREATE INDEX image_conversation ON image_generations(conversation_id);
CREATE UNIQUE INDEX image_source_once ON image_generations(run_id) WHERE json_extract(request_json,'$.execution') IS NULL;`,
	},
	{
		id: "image/0004-generated-version",
		after: ["image/0003-execution-calls"],
		sql: "ALTER TABLE image_generations ADD COLUMN generated_version TEXT",
	},
	{
		id: "image/0005-prototype-origin",
		after: ["image/0004-generated-version"],
		sql: `
CREATE TABLE image_generations_next (
 id TEXT PRIMARY KEY,
 run_id TEXT,
 conversation_id TEXT,
 record_json TEXT NOT NULL,
 request_json TEXT NOT NULL,
 plan_json TEXT,
 bindings_json TEXT NOT NULL,
 deadline INTEGER NOT NULL,
 queue_job_id TEXT,
 generated_version TEXT,
 origin TEXT NOT NULL DEFAULT 'conversation',
 prototype_id TEXT,
 operation_id TEXT,
 grant_revision INTEGER,
 hard_deadline INTEGER,
 CHECK (
   (origin = 'conversation' AND run_id IS NOT NULL AND conversation_id IS NOT NULL
    AND prototype_id IS NULL AND operation_id IS NULL AND grant_revision IS NULL
    AND hard_deadline IS NULL)
   OR
   (origin = 'prototype' AND run_id IS NULL AND conversation_id IS NULL
    AND prototype_id IS NOT NULL AND operation_id IS NOT NULL AND grant_revision IS NOT NULL
    AND plan_json IS NOT NULL AND hard_deadline IS NOT NULL AND deadline <= hard_deadline)
 )
);
INSERT INTO image_generations_next(
 rowid, id, run_id, conversation_id, record_json, request_json, plan_json, bindings_json,
 deadline, queue_job_id, generated_version
)
SELECT rowid, id, run_id, conversation_id, record_json, request_json, plan_json, bindings_json,
 deadline, queue_job_id, generated_version FROM image_generations;
DROP TABLE image_generations;
ALTER TABLE image_generations_next RENAME TO image_generations;
CREATE INDEX image_conversation ON image_generations(conversation_id)
 WHERE origin = 'conversation';
CREATE UNIQUE INDEX image_source_once ON image_generations(run_id)
 WHERE origin = 'conversation' AND json_extract(request_json,'$.execution') IS NULL;
CREATE UNIQUE INDEX image_prototype_operation ON image_generations(prototype_id, operation_id)
 WHERE origin = 'prototype';
`,
	},
];
export function stampGeneratedVersion(
	db: Database,
	id: string,
	version: string,
) {
	db.query("UPDATE image_generations SET generated_version=? WHERE id=?").run(
		version,
		id,
	);
}
export function generatedVersion(
	db: Database,
	runId: string,
	conversationId: string,
	artifactId: string,
): string | null {
	const found = db
		.query(
			`
		SELECT generated_version FROM image_generations
		WHERE origin='conversation' AND run_id=? AND conversation_id=? AND json_extract(record_json,'$.artifactId')=?
			AND json_extract(record_json,'$.state')='completed'
			AND json_extract(request_json,'$.execution.erased') IS NULL
		ORDER BY rowid DESC LIMIT 1`,
		)
		.get(runId, conversationId, artifactId) as {
		generated_version: string | null;
	} | null;
	return found?.generated_version ?? null;
}
export type Row = {
	id: string;
	run_id: string | null;
	conversation_id: string | null;
	origin: "conversation" | "prototype";
	prototype_id: string | null;
	operation_id: string | null;
	grant_revision: number | null;
	hard_deadline: number | null;
	generated_version: string | null;
	record_json: string;
	request_json: string;
	plan_json: string | null;
	bindings_json: string;
	deadline: number;
	queue_job_id: string | null;
};
export function row(db: Database, id: string) {
	return db
		.query("SELECT * FROM image_generations WHERE id=?")
		.get(id) as Row | null;
}
export type StoredImage = Omit<ImageRecord, "runId" | "conversationId"> & {
	runId: string | null;
	conversationId: string | null;
};
export function record(r: Row): StoredImage {
	return JSON.parse(r.record_json);
}
export function patch(db: Database, id: string, change: Partial<StoredImage>) {
	const r = row(db, id);
	if (!r) throw new Error("image_not_found");
	const v = { ...record(r), ...change, updatedAt: Date.now() };
	db.query("UPDATE image_generations SET record_json=? WHERE id=?").run(
		JSON.stringify(v),
		id,
	);
	return v;
}
export function list(db: Database, conversationId: string) {
	return (
		db
			.query(
				"SELECT record_json FROM image_generations WHERE origin='conversation' AND conversation_id=? ORDER BY rowid DESC LIMIT 100",
			)
			.all(conversationId) as { record_json: string }[]
	).map((r) => JSON.parse(r.record_json) as ImageRecord);
}

/** Generations running now, and the newest completion and failure since `since` (monitoring). */
export function activity(db: Database, since: number) {
	const records = (
		db
			.query(
				"SELECT record_json FROM image_generations WHERE origin='conversation' ORDER BY rowid DESC LIMIT 50",
			)
			.all() as { record_json: string }[]
	).map((r) => JSON.parse(r.record_json) as ImageRecord);
	const recent = records
		.filter((r) => r.updatedAt >= since)
		.sort((a, b) => b.updatedAt - a.updatedAt);
	const success = recent.find((r) => r.state === "completed");
	const failure = recent.find((r) => r.state === "failed");
	return {
		running: records.filter(
			(r) => r.state === "planning" || r.state === "generating",
		).length,
		lastSuccessAt: success?.updatedAt ?? null,
		lastFailure: failure
			? { at: failure.updatedAt, reason: failure.errorCode ?? "failed" }
			: null,
	};
}

/** Completed generations that produced a library image, newest first. */
export function imageGenerations(db: Database) {
	return (
		db
			.query(
				"SELECT record_json FROM image_generations WHERE origin='conversation' AND json_extract(record_json,'$.state')='completed' AND json_extract(record_json,'$.artifactId') IS NOT NULL ORDER BY rowid DESC",
			)
			.all() as { record_json: string }[]
	).map((r) => JSON.parse(r.record_json) as ImageRecord);
}

/** The completed generation that produced the library image `artifactId`. */
export function imageByArtifact(db: Database, artifactId: string) {
	const r = db
		.query(
			"SELECT record_json FROM image_generations WHERE origin='conversation' AND json_extract(record_json,'$.state')='completed' AND json_extract(record_json,'$.artifactId')=? ORDER BY rowid DESC LIMIT 1",
		)
		.get(artifactId) as { record_json: string } | null;
	return r ? (JSON.parse(r.record_json) as ImageRecord) : null;
}

export function conversationRecord(r: Row | null): ImageRecord | null {
	if (r?.origin !== "conversation") return null;
	return { ...record(r), runId: r.run_id!, conversationId: r.conversation_id! };
}

export function prototypeGeneration(
	db: Database,
	id: string,
	operation: string,
) {
	return db
		.query<Row, [string, string]>(
			"SELECT * FROM image_generations WHERE origin='prototype' AND prototype_id=? AND operation_id=?",
		)
		.get(id, operation);
}
