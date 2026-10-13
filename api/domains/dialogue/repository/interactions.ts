import type { Database } from "bun:sqlite";
import type { InteractionStatus } from "../contracts/command-interactions";

/**
 * One operation's question and answer (spec 2026-10-13 §7). The row owns the frozen
 * chain/package/binding refs, the open question and the counters that make an answer, a
 * cancellation and a late model result decidable; it does not copy the run's own state.
 */
export const commandInteractionsMigration = `
CREATE TABLE command_interactions (
 id TEXT PRIMARY KEY,
 conversation_id TEXT NOT NULL REFERENCES conversations(id),
 origin_message_id TEXT NOT NULL REFERENCES messages(id),
 origin_run_id TEXT NOT NULL REFERENCES dialogue_runs(id),
 current_run_id TEXT NOT NULL REFERENCES dialogue_runs(id),
 chain_revision_id TEXT NOT NULL,
 function_name TEXT NOT NULL,
 package_revision_id TEXT NOT NULL,
 binding_revision_id TEXT NOT NULL,
 artifact_revision_id TEXT,
 revision INTEGER NOT NULL,
 authority_epoch INTEGER NOT NULL,
 execution_generation INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('waiting_input','ready','invoking','completed','cancelled','expired','indeterminate')),
 question_id TEXT,
 question_prompt TEXT,
 question_schema_ref TEXT,
 question_count INTEGER NOT NULL,
 request_text TEXT,
 input_json TEXT,
 request_id TEXT NOT NULL,
 issued_at TEXT,
 receipt_owner TEXT,
 receipt_operation_id TEXT,
 receipt_digest TEXT,
 end_code TEXT,
 expires_at TEXT NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 ended_at TEXT,
 body_deleted_at TEXT
);
CREATE INDEX command_interactions_conversation ON command_interactions(conversation_id, created_at);
CREATE INDEX command_interactions_status ON command_interactions(status, expires_at);
CREATE INDEX command_interactions_run ON command_interactions(current_run_id);
CREATE UNIQUE INDEX command_interactions_question ON command_interactions(question_id) WHERE question_id IS NOT NULL;
CREATE TABLE command_interaction_events (
 id TEXT PRIMARY KEY,
 interaction_id TEXT NOT NULL REFERENCES command_interactions(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('question','answer','invoke','cancel','end')),
 event_id TEXT NOT NULL UNIQUE,
 payload_json TEXT,
 created_at TEXT NOT NULL
);
CREATE INDEX command_interaction_events_interaction ON command_interaction_events(interaction_id, created_at);
`;

/** The host-issued choices of an open question (a later migration, so 0005 stays as shipped). */
export const questionChoicesMigration = `ALTER TABLE command_interactions ADD COLUMN question_choices_json TEXT;`;

export type InteractionRow = {
	id: string;
	conversationId: string;
	originMessageId: string;
	originRunId: string;
	currentRunId: string;
	chainRevisionId: string;
	functionName: string;
	packageRevisionId: string;
	bindingRevisionId: string;
	artifactRevisionId: string | null;
	revision: number;
	authorityEpoch: number;
	executionGeneration: number;
	status: InteractionStatus;
	questionId: string | null;
	questionPrompt: string | null;
	questionSchemaRef: string | null;
	questionChoicesJson: string | null;
	questionCount: number;
	requestText: string | null;
	inputJson: string | null;
	requestId: string;
	issuedAt: string | null;
	receiptOwner: string | null;
	receiptOperationId: string | null;
	receiptDigest: string | null;
	endCode: string | null;
	expiresAt: string;
	createdAt: string;
	updatedAt: string;
	endedAt: string | null;
	bodyDeletedAt: string | null;
};

export type InteractionEventRow = {
	id: string;
	interactionId: string;
	kind: "question" | "answer" | "invoke" | "cancel" | "end";
	eventId: string;
	payloadJson: string | null;
	createdAt: string;
};

function map(row: Record<string, unknown>): InteractionRow {
	return {
		id: row.id as string,
		conversationId: row.conversation_id as string,
		originMessageId: row.origin_message_id as string,
		originRunId: row.origin_run_id as string,
		currentRunId: row.current_run_id as string,
		chainRevisionId: row.chain_revision_id as string,
		functionName: row.function_name as string,
		packageRevisionId: row.package_revision_id as string,
		bindingRevisionId: row.binding_revision_id as string,
		artifactRevisionId: row.artifact_revision_id as string | null,
		revision: row.revision as number,
		authorityEpoch: row.authority_epoch as number,
		executionGeneration: row.execution_generation as number,
		status: row.status as InteractionStatus,
		questionId: row.question_id as string | null,
		questionPrompt: row.question_prompt as string | null,
		questionSchemaRef: row.question_schema_ref as string | null,
		questionChoicesJson: row.question_choices_json as string | null,
		questionCount: row.question_count as number,
		requestText: row.request_text as string | null,
		inputJson: row.input_json as string | null,
		requestId: row.request_id as string,
		issuedAt: row.issued_at as string | null,
		receiptOwner: row.receipt_owner as string | null,
		receiptOperationId: row.receipt_operation_id as string | null,
		receiptDigest: row.receipt_digest as string | null,
		endCode: row.end_code as string | null,
		expiresAt: row.expires_at as string,
		createdAt: row.created_at as string,
		updatedAt: row.updated_at as string,
		endedAt: row.ended_at as string | null,
		bodyDeletedAt: row.body_deleted_at as string | null,
	};
}

export const OPEN_STATUSES = ["waiting_input", "ready", "invoking"] as const;

export function interactionById(db: Database, id: string) {
	const row = db
		.query("SELECT * FROM command_interactions WHERE id=?")
		.get(id) as Record<string, unknown> | null;
	return row ? map(row) : null;
}
export function interactionByQuestion(db: Database, questionId: string) {
	const row = db
		.query("SELECT * FROM command_interactions WHERE question_id=?")
		.get(questionId) as Record<string, unknown> | null;
	return row ? map(row) : null;
}
/** The interaction a run currently serves while the operation is still open. */
export function openInteractionOfRun(db: Database, runId: string) {
	const row = db
		.query(
			"SELECT * FROM command_interactions WHERE current_run_id=? AND status IN ('ready','invoking') ORDER BY created_at DESC LIMIT 1",
		)
		.get(runId) as Record<string, unknown> | null;
	return row ? map(row) : null;
}
export function listInteractions(
	db: Database,
	conversationId: string,
	limit: number,
) {
	return (
		db
			.query(
				"SELECT * FROM command_interactions WHERE conversation_id=? ORDER BY created_at DESC, id LIMIT ?",
			)
			.all(conversationId, limit) as Record<string, unknown>[]
	).map(map);
}
export function openQuestionRows(
	db: Database,
	conversationId: string,
	nowIso: string,
	limit: number,
) {
	return (
		db
			.query(
				"SELECT * FROM command_interactions WHERE conversation_id=? AND status='waiting_input' AND question_id IS NOT NULL AND expires_at>? ORDER BY updated_at DESC, id LIMIT ?",
			)
			.all(conversationId, nowIso, limit) as Record<string, unknown>[]
	).map(map);
}
export function interactionCounts(db: Database) {
	const row = db
		.query(
			"SELECT COUNT(*) AS total, COALESCE(SUM(status IN ('waiting_input','ready','invoking')),0) AS open FROM command_interactions",
		)
		.get() as { total: number; open: number };
	return row;
}
export function insertInteraction(db: Database, row: InteractionRow) {
	db.query(
		`INSERT INTO command_interactions(id,conversation_id,origin_message_id,origin_run_id,current_run_id,chain_revision_id,function_name,package_revision_id,binding_revision_id,artifact_revision_id,revision,authority_epoch,execution_generation,status,question_id,question_prompt,question_schema_ref,question_choices_json,question_count,request_text,input_json,request_id,issued_at,receipt_owner,receipt_operation_id,receipt_digest,end_code,expires_at,created_at,updated_at,ended_at,body_deleted_at)
		 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
	).run(
		row.id,
		row.conversationId,
		row.originMessageId,
		row.originRunId,
		row.currentRunId,
		row.chainRevisionId,
		row.functionName,
		row.packageRevisionId,
		row.bindingRevisionId,
		row.artifactRevisionId,
		row.revision,
		row.authorityEpoch,
		row.executionGeneration,
		row.status,
		row.questionId,
		row.questionPrompt,
		row.questionSchemaRef,
		row.questionChoicesJson,
		row.questionCount,
		row.requestText,
		row.inputJson,
		row.requestId,
		row.issuedAt,
		row.receiptOwner,
		row.receiptOperationId,
		row.receiptDigest,
		row.endCode,
		row.expiresAt,
		row.createdAt,
		row.updatedAt,
		row.endedAt,
		row.bodyDeletedAt,
	);
}

export function eventsOf(db: Database, interactionId: string) {
	return (
		db
			.query(
				"SELECT * FROM command_interaction_events WHERE interaction_id=? ORDER BY rowid",
			)
			.all(interactionId) as Record<string, unknown>[]
	).map((row): InteractionEventRow => ({
		id: row.id as string,
		interactionId: row.interaction_id as string,
		kind: row.kind as InteractionEventRow["kind"],
		eventId: row.event_id as string,
		payloadJson: row.payload_json as string | null,
		createdAt: row.created_at as string,
	}));
}
export function eventByEventId(db: Database, eventId: string) {
	const row = db
		.query("SELECT * FROM command_interaction_events WHERE event_id=?")
		.get(eventId) as Record<string, unknown> | null;
	return row
		? ({
				id: row.id as string,
				interactionId: row.interaction_id as string,
				kind: row.kind as InteractionEventRow["kind"],
				eventId: row.event_id as string,
				payloadJson: row.payload_json as string | null,
				createdAt: row.created_at as string,
			} satisfies InteractionEventRow)
		: null;
}
export function insertEvent(
	db: Database,
	event: Omit<InteractionEventRow, "payloadJson"> & {
		payload: unknown;
	},
) {
	db.query(
		"INSERT INTO command_interaction_events(id,interaction_id,kind,event_id,payload_json,created_at) VALUES(?,?,?,?,?,?)",
	).run(
		event.id,
		event.interactionId,
		event.kind,
		event.eventId,
		event.payload === undefined ? null : JSON.stringify(event.payload),
		event.createdAt,
	);
}
/** Bytes of the bodies one interaction keeps (request, frozen input, question, event payloads). */
export function bodyBytes(db: Database, interactionId: string) {
	const row = db
		.query(
			`SELECT COALESCE(LENGTH(CAST(i.request_text AS BLOB)),0)+COALESCE(LENGTH(CAST(i.input_json AS BLOB)),0)+COALESCE(LENGTH(CAST(i.question_prompt AS BLOB)),0)+COALESCE(LENGTH(CAST(i.question_choices_json AS BLOB)),0)
			 +COALESCE((SELECT SUM(LENGTH(CAST(payload_json AS BLOB))) FROM command_interaction_events WHERE interaction_id=i.id),0) AS bytes
			 FROM command_interactions i WHERE i.id=?`,
		)
		.get(interactionId) as { bytes: number } | null;
	return row?.bytes ?? 0;
}
