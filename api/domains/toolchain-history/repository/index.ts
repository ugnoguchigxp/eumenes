import type { Migration } from "../../../infrastructure/sqlite";

const migration = `
CREATE TABLE toolchain_selections(
 id TEXT PRIMARY KEY,run_id TEXT NOT NULL UNIQUE,conversation_id TEXT NOT NULL,
 utterance_id TEXT,request_id TEXT,
 retrieval TEXT NOT NULL CHECK(retrieval IN ('fts','embedding','hybrid','none')),
 candidates_json TEXT NOT NULL,history_refs_json TEXT NOT NULL,
 decision TEXT NOT NULL CHECK(decision IN ('toolchain','answer','rejected')),
 toolchain_id TEXT,toolchain_revision_id TEXT,function_name TEXT,request_text TEXT,
 repaired INTEGER NOT NULL DEFAULT 0,task_id TEXT,
 outcome TEXT,outcome_code TEXT,recipe TEXT CHECK(recipe IS NULL OR recipe IN ('matched','missed','saved')),
 duration_ms INTEGER,query_space TEXT,query_vector BLOB,
 created_at INTEGER NOT NULL,settled_at INTEGER,expires_at INTEGER NOT NULL);
CREATE INDEX toolchain_selections_created ON toolchain_selections(created_at);
CREATE INDEX toolchain_selections_expiry ON toolchain_selections(expires_at);
CREATE INDEX toolchain_selections_space ON toolchain_selections(query_space,created_at);
CREATE TABLE toolchain_recipes(
 id TEXT PRIMARY KEY,toolchain_id TEXT NOT NULL,signature TEXT NOT NULL,url TEXT NOT NULL,
 read_hint TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('active','suspended','disabled')),
 successes INTEGER NOT NULL DEFAULT 0,failures INTEGER NOT NULL DEFAULT 0,
 consecutive_failures INTEGER NOT NULL DEFAULT 0,
 last_success_at INTEGER,last_failure_at INTEGER,
 created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
 UNIQUE(toolchain_id,signature));
CREATE VIRTUAL TABLE toolchain_recipe_search USING fts5(id UNINDEXED,content,tokenize='trigram');
CREATE TABLE toolchain_recipe_vectors(
 recipe_id TEXT NOT NULL REFERENCES toolchain_recipes(id) ON DELETE CASCADE,
 space TEXT NOT NULL,text_digest TEXT NOT NULL,vector BLOB NOT NULL,
 PRIMARY KEY(recipe_id,space));
`;

export type SelectionRow = {
	id: string;
	run_id: string;
	conversation_id: string;
	utterance_id: string | null;
	request_id: string | null;
	retrieval: "fts" | "embedding" | "hybrid" | "none";
	candidates_json: string;
	history_refs_json: string;
	decision: "toolchain" | "answer" | "rejected";
	toolchain_id: string | null;
	toolchain_revision_id: string | null;
	function_name: string | null;
	request_text: string | null;
	task_id: string | null;
	outcome: string | null;
	outcome_code: string | null;
	recipe: "matched" | "missed" | "saved" | null;
	duration_ms: number | null;
	query_space: string | null;
	query_vector: Uint8Array | null;
	created_at: number;
	settled_at: number | null;
	expires_at: number;
};
export type RouterTraceRow = {
	run_id: string;
	conversation_id: string;
	message_id: string;
	message_ids_json: string;
	query_text: string;
	query_space: string | null;
	query_space_json: string | null;
	query_vector: Uint8Array | null;
	decided_id: string | null;
	work_id: string | null;
	set_json: string;
	trace_json: string;
	created_at: number;
	expires_at: number;
};
export type RouterFeedbackRow = {
	id: string;
	conversation_id: string;
	message_id: string;
	message_ids_json: string;
	run_id: string;
	source: "redirect" | "ask_answer" | "ui_pick" | "review";
	query_text: string;
	query_space: string;
	query_vector: Uint8Array;
	wrong_id: string | null;
	right_id: string;
	state: "active" | "retracted" | "stale" | "conflict";
	created_at: number;
	updated_at: number;
};
export type RecipeRow = {
	id: string;
	toolchain_id: string;
	signature: string;
	url: string;
	read_hint: string;
	state: "active" | "suspended" | "disabled";
	successes: number;
	failures: number;
	consecutive_failures: number;
	last_success_at: number | null;
	last_failure_at: number | null;
	created_at: number;
	updated_at: number;
};

/** Named migrations of this domain; the SQL above is frozen once deployed. */
export const migrations: readonly Migration[] = [
	{
		id: "toolchain-history/0001-init",
		sql: migration,
		after: ["capabilities/0003-toolchain-vectors"],
	},
	{
		// The Web research toolchain, formerly named after its model, has the model-neutral id `web.research.codex`.
		id: "toolchain-history/0002-rename-web-research",
		after: ["toolchain-history/0001-init"],
		sql: `UPDATE toolchain_selections SET toolchain_id='web.research.codex' WHERE toolchain_id LIKE 'web.research.%' AND toolchain_id<>'web.research.codex';
UPDATE toolchain_recipes SET toolchain_id='web.research.codex' WHERE toolchain_id LIKE 'web.research.%' AND toolchain_id<>'web.research.codex';`,
	},
	{
		// The first round's judgment of the request (kind, freshness, next, impact, approved), kept with the selection.
		id: "toolchain-history/0003-selection-analysis",
		after: ["toolchain-history/0002-rename-web-research"],
		sql: "ALTER TABLE toolchain_selections ADD COLUMN analysis_json TEXT;",
	},
	{
		// The conversation agent no longer classifies a request nor repairs its output: neither is kept.
		id: "toolchain-history/0004-drop-analysis",
		after: ["toolchain-history/0003-selection-analysis"],
		sql: `ALTER TABLE toolchain_selections DROP COLUMN analysis_json;
ALTER TABLE toolchain_selections DROP COLUMN repaired;`,
	},
	{
		// The router's per-turn traces and the user's corrections of it (spec toolchain-router-redesign §5.3).
		id: "toolchain-history/0005-router",
		after: ["toolchain-history/0004-drop-analysis"],
		sql: `CREATE TABLE router_traces(
 run_id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,message_id TEXT NOT NULL,message_ids_json TEXT NOT NULL,
 query_text TEXT NOT NULL,query_space TEXT,query_space_json TEXT,query_vector BLOB,
 decided_id TEXT,work_id TEXT,set_json TEXT NOT NULL,trace_json TEXT NOT NULL,
 created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL);
CREATE INDEX router_traces_conversation ON router_traces(conversation_id,created_at);
CREATE INDEX router_traces_message ON router_traces(message_id);
CREATE INDEX router_traces_expiry ON router_traces(expires_at);
CREATE TABLE router_feedback(
 id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,message_id TEXT NOT NULL,message_ids_json TEXT NOT NULL,run_id TEXT NOT NULL,
 source TEXT NOT NULL CHECK(source IN ('redirect','ask_answer','ui_pick','review')),
 query_text TEXT NOT NULL,query_space TEXT NOT NULL,query_vector BLOB NOT NULL,
 wrong_id TEXT,right_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('active','retracted','stale','conflict')),
 created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE INDEX router_feedback_space ON router_feedback(query_space,state);
CREATE INDEX router_feedback_message ON router_feedback(message_id);`,
	},
];
