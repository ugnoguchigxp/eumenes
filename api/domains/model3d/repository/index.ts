import type { Database } from "bun:sqlite";
import type { Migration } from "../../../infrastructure/sqlite";
import {
	errorLabel,
	stageLabel,
	type GenerationState,
	type Model3dAsset,
	type Model3dFocus,
	type Model3dGeneration,
	type Model3dSource,
} from "../contracts";

/** The screen's focus and the conversation's targets share one slot per owner. */
export const FOCUS_SLOT = "main";

export const migrations: readonly Migration[] = [
	{
		id: "model3d/0001-init",
		after: ["queue/0001-init"],
		sql: `
CREATE TABLE model3d_generations (
 id TEXT PRIMARY KEY, owner TEXT NOT NULL, conversation_id TEXT NOT NULL,
 origin TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE, idempotency_key TEXT NOT NULL,
 title TEXT NOT NULL, tags_json TEXT NOT NULL, source_json TEXT NOT NULL, seed INTEGER NOT NULL,
 request_json TEXT, service_path TEXT, job_id TEXT,
 state TEXT NOT NULL, stage TEXT, asset_id TEXT, deleted INTEGER NOT NULL DEFAULT 0,
 warnings_json TEXT NOT NULL DEFAULT '[]', error_code TEXT, announced INTEGER NOT NULL DEFAULT 0,
 step INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0, deadline INTEGER NOT NULL,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX model3d_generations_owner ON model3d_generations(owner, created_at);
CREATE TABLE model3d_assets (
 id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL, tags_json TEXT NOT NULL,
 created_at TEXT NOT NULL, prompt TEXT, warnings_json TEXT NOT NULL, has_source INTEGER NOT NULL,
 seen_at INTEGER NOT NULL
);
CREATE INDEX model3d_assets_owner ON model3d_assets(owner, created_at);
CREATE TABLE model3d_operations (
 id TEXT PRIMARY KEY, owner TEXT NOT NULL, conversation_id TEXT NOT NULL, kind TEXT NOT NULL,
 asset_id TEXT NOT NULL, patch_json TEXT, state TEXT NOT NULL, error_code TEXT,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE model3d_commands (
 request_id TEXT PRIMARY KEY, owner TEXT NOT NULL, conversation_id TEXT NOT NULL,
 operation TEXT NOT NULL, input_json TEXT NOT NULL, result_json TEXT NOT NULL
);
CREATE TABLE model3d_focus (
 owner TEXT NOT NULL, conversation_id TEXT NOT NULL, seq INTEGER NOT NULL, focus_json TEXT NOT NULL,
 PRIMARY KEY(owner, conversation_id)
);
`,
	},
];

export type GenerationRow = {
	id: string;
	owner: string;
	conversation_id: string;
	origin: "conversation" | "screen";
	request_id: string;
	idempotency_key: string;
	title: string;
	tags_json: string;
	source_json: string;
	seed: number;
	request_json: string | null;
	service_path: string | null;
	job_id: string | null;
	state: GenerationState;
	stage: string | null;
	asset_id: string | null;
	deleted: number;
	warnings_json: string;
	error_code: string | null;
	announced: number;
	step: number;
	revision: number;
	deadline: number;
	created_at: number;
	updated_at: number;
};

export const generationRow = (db: Database, id: string) =>
	db
		.query("SELECT * FROM model3d_generations WHERE id=?")
		.get(id) as GenerationRow | null;
export const generationByRequest = (db: Database, requestId: string) =>
	db
		.query("SELECT * FROM model3d_generations WHERE request_id=?")
		.get(requestId) as GenerationRow | null;
export function ownedGeneration(db: Database, id: string, owner: string) {
	const r = generationRow(db, id);
	if (!r || r.owner !== owner) throw new Error("model3d_generation_not_found");
	return r;
}

export function generationView(r: GenerationRow): Model3dGeneration {
	const deleted = !!r.deleted;
	return {
		id: r.id,
		title: r.title,
		tags: JSON.parse(r.tags_json),
		source: JSON.parse(r.source_json) as Model3dSource,
		state: r.state,
		stage: r.stage,
		stageLabel: stageLabel(r.state, r.stage, deleted),
		assetId: deleted ? null : r.asset_id,
		deleted,
		warnings: JSON.parse(r.warnings_json),
		errorCode: r.error_code,
		errorLabel: errorLabel(r.error_code),
		origin: r.origin,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
		revision: r.revision,
	};
}

type GenerationChange = Partial<
	Pick<
		GenerationRow,
		| "request_json"
		| "service_path"
		| "job_id"
		| "state"
		| "stage"
		| "asset_id"
		| "deleted"
		| "warnings_json"
		| "error_code"
		| "announced"
		| "step"
		| "deadline"
	>
>;
export function patchGeneration(
	db: Database,
	id: string,
	change: GenerationChange,
) {
	const keys = Object.keys(change) as (keyof GenerationChange)[];
	db.query(
		`UPDATE model3d_generations SET ${keys.map((k) => `${k}=?`).join(",")}${keys.length ? "," : ""} revision=revision+1, updated_at=? WHERE id=?`,
	).run(...keys.map((k) => change[k] ?? null), Date.now(), id);
	return generationRow(db, id)!;
}

export const listGenerations = (db: Database, owner: string, limit = 20) =>
	(
		db
			.query(
				"SELECT * FROM model3d_generations WHERE owner=? ORDER BY created_at DESC, rowid DESC LIMIT ?",
			)
			.all(owner, limit) as GenerationRow[]
	).map(generationView);

export const activeGenerationCount = (db: Database, owner: string) =>
	(
		db
			.query(
				"SELECT COUNT(*) AS n FROM model3d_generations WHERE owner=? AND state IN ('submitting','queued','running')",
			)
			.get(owner) as { n: number }
	).n;

type AssetRow = {
	id: string;
	title: string;
	tags_json: string;
	created_at: string;
	prompt: string | null;
	warnings_json: string;
	has_source: number;
};
const assetView = (r: AssetRow): Model3dAsset => ({
	id: r.id,
	title: r.title,
	tags: JSON.parse(r.tags_json),
	createdAt: r.created_at,
	prompt: r.prompt,
	warnings: JSON.parse(r.warnings_json),
	hasSource: !!r.has_source,
});
/** The local index of LARM's assets, for choosing targets inside a transaction. LARM stays authoritative. */
export function rememberAssets(
	db: Database,
	owner: string,
	assets: readonly Model3dAsset[],
) {
	const now = Date.now();
	const q = db.query(
		`INSERT INTO model3d_assets(id,owner,title,tags_json,created_at,prompt,warnings_json,has_source,seen_at)
		 VALUES(?,?,?,?,?,?,?,?,?)
		 ON CONFLICT(id) DO UPDATE SET title=excluded.title, tags_json=excluded.tags_json,
		 created_at=excluded.created_at, prompt=excluded.prompt, warnings_json=excluded.warnings_json,
		 has_source=excluded.has_source, seen_at=excluded.seen_at WHERE owner=excluded.owner`,
	);
	for (const a of assets)
		q.run(
			a.id,
			owner,
			a.title,
			JSON.stringify(a.tags),
			a.createdAt,
			a.prompt ? a.prompt.slice(0, 120) : null,
			JSON.stringify(a.warnings),
			a.hasSource ? 1 : 0,
			now,
		);
}
export function forgetAsset(db: Database, owner: string, id: string) {
	db.query("DELETE FROM model3d_assets WHERE id=? AND owner=?").run(id, owner);
	db.query(
		"UPDATE model3d_generations SET deleted=1, revision=revision+1, updated_at=? WHERE asset_id=? AND owner=?",
	).run(Date.now(), id, owner);
}
export const knownAsset = (db: Database, owner: string, id: string) => {
	const r = db
		.query("SELECT * FROM model3d_assets WHERE id=? AND owner=?")
		.get(id, owner) as AssetRow | null;
	return r ? assetView(r) : null;
};
export const recentAssets = (db: Database, owner: string, limit: number) =>
	(
		db
			.query(
				"SELECT * FROM model3d_assets WHERE owner=? ORDER BY created_at DESC LIMIT ?",
			)
			.all(owner, limit) as AssetRow[]
	).map(assetView);
/** Every space-separated word must appear in the title, tags or prompt excerpt; tags must all match. */
export function findAssets(
	db: Database,
	owner: string,
	query: string,
	tags: readonly string[],
	limit: number,
) {
	const words = query.split(/\s+/).filter(Boolean);
	return (
		db
			.query(
				"SELECT * FROM model3d_assets WHERE owner=? ORDER BY created_at DESC LIMIT 500",
			)
			.all(owner) as AssetRow[]
	)
		.map(assetView)
		.filter((a) => {
			const text = [a.title, ...a.tags, a.prompt ?? ""].join(" ");
			return (
				words.every((w) => text.includes(w)) &&
				tags.every((t) => a.tags.includes(t))
			);
		})
		.slice(0, limit);
}

export type OperationRow = {
	id: string;
	owner: string;
	conversation_id: string;
	kind: "update" | "delete";
	asset_id: string;
	patch_json: string | null;
	state: "pending" | "completed" | "failed";
	error_code: string | null;
	created_at: number;
	updated_at: number;
};
export const operationRow = (db: Database, id: string) =>
	db
		.query("SELECT * FROM model3d_operations WHERE id=?")
		.get(id) as OperationRow | null;
export function settleOperation(
	db: Database,
	id: string,
	state: "completed" | "failed",
	errorCode: string | null,
) {
	db.query(
		"UPDATE model3d_operations SET state=?, error_code=?, updated_at=? WHERE id=?",
	).run(state, errorCode, Date.now(), id);
}
export const pendingOperations = (db: Database, owner: string) =>
	db
		.query(
			"SELECT * FROM model3d_operations WHERE owner=? AND state='pending' ORDER BY created_at",
		)
		.all(owner) as OperationRow[];

type FocusInput = Model3dFocus extends infer F
	? F extends Model3dFocus
		? Omit<F, "seq">
		: never
	: never;
export function setFocus(
	db: Database,
	owner: string,
	conversationId: string,
	focus: FocusInput,
) {
	const current = db
		.query("SELECT seq FROM model3d_focus WHERE owner=? AND conversation_id=?")
		.get(owner, conversationId) as { seq: number } | null;
	const seq = (current?.seq ?? 0) + 1;
	const value = { ...focus, seq } as Model3dFocus;
	db.query(
		`INSERT INTO model3d_focus(owner,conversation_id,seq,focus_json) VALUES(?,?,?,?)
		 ON CONFLICT(owner,conversation_id) DO UPDATE SET seq=excluded.seq, focus_json=excluded.focus_json`,
	).run(owner, conversationId, seq, JSON.stringify(value));
	return value;
}
export const focusOf = (
	db: Database,
	owner: string,
	conversationId: string,
) => {
	const r = db
		.query(
			"SELECT focus_json FROM model3d_focus WHERE owner=? AND conversation_id=?",
		)
		.get(owner, conversationId) as { focus_json: string } | null;
	return r ? (JSON.parse(r.focus_json) as Model3dFocus) : null;
};
