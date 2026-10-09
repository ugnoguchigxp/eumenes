import type { Database } from "bun:sqlite";

/**
 * Research-route ledger. Deletion order: draft -> proof -> health -> version -> candidate -> key.
 * No FK to other domains and no key->active-version FK (the pointer is checked by activateVersionCas).
 */
export const migration = `
CREATE TABLE research_route_state(id INTEGER PRIMARY KEY CHECK(id=1),epoch INTEGER NOT NULL);
INSERT INTO research_route_state(id,epoch) VALUES(1,0);
CREATE TABLE research_route_keys(
 epoch INTEGER NOT NULL,key TEXT NOT NULL,incarnation TEXT NOT NULL UNIQUE,
 search_spec_json TEXT NOT NULL,keyword_text TEXT NOT NULL,generation INTEGER NOT NULL DEFAULT 0,
 active_version_id TEXT,enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
 control_version INTEGER NOT NULL DEFAULT 0,suspension_reason TEXT,retry_after INTEGER,
 last_success_at INTEGER,idle_expires_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
 PRIMARY KEY(epoch,key));
CREATE INDEX research_route_keys_idle ON research_route_keys(epoch,idle_expires_at);
CREATE TABLE research_search_candidates(
 epoch INTEGER NOT NULL,key TEXT NOT NULL,incarnation TEXT NOT NULL REFERENCES research_route_keys(incarnation),
 generation INTEGER NOT NULL,hits_json TEXT NOT NULL,searched_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,
 provider_version TEXT NOT NULL,digest TEXT NOT NULL,source_run_id TEXT NOT NULL,source_step_id TEXT NOT NULL,
 PRIMARY KEY(epoch,key));
CREATE INDEX research_search_candidates_expiry ON research_search_candidates(expires_at);
CREATE TABLE research_route_revisions(
 version_id TEXT PRIMARY KEY,epoch INTEGER NOT NULL,key TEXT NOT NULL,
 incarnation TEXT NOT NULL REFERENCES research_route_keys(incarnation),revision INTEGER NOT NULL,
 recipe_json TEXT NOT NULL,context_projection TEXT NOT NULL,skill_revision_id TEXT NOT NULL,
 package_revision_id TEXT NOT NULL,proof_digest TEXT NOT NULL,review_digest TEXT NOT NULL,
 registration_certificate_json TEXT NOT NULL,validation_policy_version INTEGER NOT NULL,
 created_at INTEGER NOT NULL,revalidate_at INTEGER NOT NULL,
 UNIQUE(incarnation,revision));
CREATE INDEX research_route_revisions_key ON research_route_revisions(epoch,key);
CREATE TABLE research_route_revision_health(
 version_id TEXT PRIMARY KEY REFERENCES research_route_revisions(version_id),
 disqualified_at INTEGER NOT NULL,reason TEXT NOT NULL);
CREATE TABLE research_route_proofs(
 id TEXT PRIMARY KEY,root_run_id TEXT NOT NULL,task_id TEXT NOT NULL,ticket_id TEXT,report_epoch INTEGER,
 epoch INTEGER NOT NULL,incarnation TEXT NOT NULL REFERENCES research_route_keys(incarnation),
 key TEXT NOT NULL,generation INTEGER NOT NULL,source_url TEXT NOT NULL,binding_json TEXT NOT NULL,
 projection_digest TEXT NOT NULL,lookup_provenance_json TEXT NOT NULL,validation_policy_version INTEGER NOT NULL,
 facts_json TEXT NOT NULL,fetched_at INTEGER NOT NULL,validated_at INTEGER NOT NULL,adopted_at INTEGER,
 status TEXT NOT NULL CHECK(status IN ('observed','adopted','expired','consumed')),digest TEXT NOT NULL,
 expires_at INTEGER NOT NULL);
CREATE INDEX research_route_proofs_run ON research_route_proofs(root_run_id,task_id);
CREATE INDEX research_route_proofs_key ON research_route_proofs(incarnation,status);
CREATE INDEX research_route_proofs_expiry ON research_route_proofs(expires_at);
CREATE TABLE research_route_drafts(
 id TEXT PRIMARY KEY,key TEXT NOT NULL,epoch INTEGER NOT NULL,
 incarnation TEXT NOT NULL REFERENCES research_route_keys(incarnation),base_generation INTEGER NOT NULL,
 base_version_id TEXT REFERENCES research_route_revisions(version_id),
 origin TEXT NOT NULL CHECK(origin IN ('adoption','edit')),
 proof_id TEXT REFERENCES research_route_proofs(id),base_certificate_digest TEXT,
 instruction TEXT,skill_draft TEXT,review_json TEXT,corrections INTEGER NOT NULL DEFAULT 0,
 state TEXT NOT NULL CHECK(state IN ('queued','authoring','reviewing','activated','rejected','interrupted','superseded')),
 error_code TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,
 CHECK((origin='adoption' AND proof_id IS NOT NULL AND base_certificate_digest IS NULL) OR
       (origin='edit' AND proof_id IS NULL AND base_certificate_digest IS NOT NULL AND base_version_id IS NOT NULL)));
CREATE UNIQUE INDEX research_route_drafts_open ON research_route_drafts(incarnation) WHERE state IN ('queued','authoring','reviewing');
CREATE INDEX research_route_drafts_key ON research_route_drafts(epoch,key,state);
CREATE TABLE research_route_operations(
 scope TEXT NOT NULL,request_id TEXT NOT NULL,input_digest TEXT NOT NULL,response_json TEXT NOT NULL,
 status INTEGER NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,
 UNIQUE(scope,request_id));
CREATE INDEX research_route_operations_expiry ON research_route_operations(expires_at);
`;

export type KeyRow = {
	epoch: number;
	key: string;
	incarnation: string;
	search_spec_json: string;
	keyword_text: string;
	generation: number;
	active_version_id: string | null;
	enabled: number;
	control_version: number;
	suspension_reason: string | null;
	retry_after: number | null;
	last_success_at: number | null;
	idle_expires_at: number | null;
	created_at: number;
	updated_at: number;
};
export type CandidateRow = {
	epoch: number;
	key: string;
	incarnation: string;
	generation: number;
	hits_json: string;
	searched_at: number;
	expires_at: number;
	provider_version: string;
	digest: string;
	source_run_id: string;
	source_step_id: string;
};
export type RevisionRow = {
	version_id: string;
	epoch: number;
	key: string;
	incarnation: string;
	revision: number;
	recipe_json: string;
	context_projection: string;
	skill_revision_id: string;
	package_revision_id: string;
	proof_digest: string;
	review_digest: string;
	registration_certificate_json: string;
	validation_policy_version: number;
	created_at: number;
	revalidate_at: number;
};
export type ProofRow = {
	id: string;
	root_run_id: string;
	task_id: string;
	ticket_id: string | null;
	report_epoch: number | null;
	epoch: number;
	incarnation: string;
	key: string;
	generation: number;
	source_url: string;
	binding_json: string;
	projection_digest: string;
	lookup_provenance_json: string;
	validation_policy_version: number;
	facts_json: string;
	fetched_at: number;
	validated_at: number;
	adopted_at: number | null;
	status: "observed" | "adopted" | "expired" | "consumed";
	digest: string;
	expires_at: number;
};
export type DraftRow = {
	id: string;
	key: string;
	epoch: number;
	incarnation: string;
	base_generation: number;
	base_version_id: string | null;
	origin: "adoption" | "edit";
	proof_id: string | null;
	base_certificate_digest: string | null;
	instruction: string | null;
	skill_draft: string | null;
	review_json: string | null;
	corrections: number;
	state: string;
	error_code: string | null;
	created_at: number;
	updated_at: number;
	expires_at: number;
};
export type OperationRow = {
	scope: string;
	request_id: string;
	input_digest: string;
	response_json: string;
	status: number;
	created_at: number;
	expires_at: number;
};

export const getEpoch = (db: Database) =>
	(
		db.query("SELECT epoch FROM research_route_state WHERE id=1").get() as {
			epoch: number;
		}
	).epoch;
export const bumpEpoch = (db: Database) =>
	(
		db
			.query(
				"UPDATE research_route_state SET epoch=epoch+1 WHERE id=1 RETURNING epoch",
			)
			.get() as {
			epoch: number;
		}
	).epoch;

export const getKey = (db: Database, epoch: number, key: string) =>
	db
		.query("SELECT * FROM research_route_keys WHERE epoch=? AND key=?")
		.get(epoch, key) as KeyRow | null;
export const getKeyByIncarnation = (db: Database, incarnation: string) =>
	db
		.query("SELECT * FROM research_route_keys WHERE incarnation=?")
		.get(incarnation) as KeyRow | null;
export const countKeys = (db: Database, epoch: number) =>
	(
		db
			.query("SELECT COUNT(*) n FROM research_route_keys WHERE epoch=?")
			.get(epoch) as { n: number }
	).n;
export function insertKey(
	db: Database,
	row: {
		epoch: number;
		key: string;
		incarnation: string;
		specJson: string;
		keywords: string;
		now: number;
	},
) {
	db.query(
		"INSERT INTO research_route_keys(epoch,key,incarnation,search_spec_json,keyword_text,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
	).run(
		row.epoch,
		row.key,
		row.incarnation,
		row.specJson,
		row.keywords,
		row.now,
		row.now,
	);
}
/** Keys of the visible epoch in key ASC order, strictly after `afterKey`. */
export const listKeys = (
	db: Database,
	epoch: number,
	afterKey: string | null,
	limit: number,
) =>
	db
		.query(
			"SELECT * FROM research_route_keys WHERE epoch=? AND key>? ORDER BY key ASC LIMIT ?",
		)
		.all(epoch, afterKey ?? "", limit) as KeyRow[];

/** Bump control_version (administrative state change) and optionally generation. */
export function touchKey(
	db: Database,
	row: KeyRow,
	now: number,
	patch: Partial<
		Pick<
			KeyRow,
			"enabled" | "active_version_id" | "suspension_reason" | "retry_after"
		>
	> & {
		generation?: boolean;
	},
) {
	const next = {
		enabled: patch.enabled ?? row.enabled,
		active_version_id:
			patch.active_version_id === undefined
				? row.active_version_id
				: patch.active_version_id,
		suspension_reason:
			patch.suspension_reason === undefined
				? row.suspension_reason
				: patch.suspension_reason,
		retry_after:
			patch.retry_after === undefined ? row.retry_after : patch.retry_after,
	};
	return (
		db
			.query(
				`UPDATE research_route_keys SET enabled=?,active_version_id=?,suspension_reason=?,retry_after=?,
			 generation=generation+?,control_version=control_version+1,updated_at=?
			 WHERE epoch=? AND key=? AND incarnation=? AND generation=? AND control_version=?`,
			)
			.run(
				next.enabled,
				next.active_version_id,
				next.suspension_reason,
				next.retry_after,
				patch.generation ? 1 : 0,
				now,
				row.epoch,
				row.key,
				row.incarnation,
				row.generation,
				row.control_version,
			).changes === 1
	);
}
/** Warm success: refresh lastSuccessAt/idle only; generation and control_version stay. */
export const markUsed = (
	db: Database,
	row: KeyRow,
	usedAt: number,
	idleExpiresAt: number,
) =>
	db
		.query(
			`UPDATE research_route_keys SET last_success_at=?,idle_expires_at=?
			 WHERE epoch=? AND key=? AND incarnation=? AND generation=?`,
		)
		.run(
			usedAt,
			idleExpiresAt,
			row.epoch,
			row.key,
			row.incarnation,
			row.generation,
		).changes === 1;

export const getCandidate = (db: Database, epoch: number, key: string) =>
	db
		.query("SELECT * FROM research_search_candidates WHERE epoch=? AND key=?")
		.get(epoch, key) as CandidateRow | null;
export const putCandidate = (db: Database, c: CandidateRow) =>
	db
		.query(
			`INSERT OR REPLACE INTO research_search_candidates(epoch,key,incarnation,generation,hits_json,searched_at,expires_at,provider_version,digest,source_run_id,source_step_id)
			 VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
		)
		.run(
			c.epoch,
			c.key,
			c.incarnation,
			c.generation,
			c.hits_json,
			c.searched_at,
			c.expires_at,
			c.provider_version,
			c.digest,
			c.source_run_id,
			c.source_step_id,
		);
export const deleteCandidate = (db: Database, epoch: number, key: string) =>
	db
		.query("DELETE FROM research_search_candidates WHERE epoch=? AND key=?")
		.run(epoch, key);

export const getRevision = (db: Database, versionId: string) =>
	db
		.query("SELECT * FROM research_route_revisions WHERE version_id=?")
		.get(versionId) as RevisionRow | null;
export const nextRevisionNumber = (db: Database, incarnation: string) =>
	(
		db
			.query(
				"SELECT COALESCE(MAX(revision),0)+1 n FROM research_route_revisions WHERE incarnation=?",
			)
			.get(incarnation) as { n: number }
	).n;
export function insertRevision(db: Database, r: RevisionRow) {
	db.query(
		`INSERT INTO research_route_revisions(version_id,epoch,key,incarnation,revision,recipe_json,context_projection,skill_revision_id,package_revision_id,proof_digest,review_digest,registration_certificate_json,validation_policy_version,created_at,revalidate_at)
		 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
	).run(
		r.version_id,
		r.epoch,
		r.key,
		r.incarnation,
		r.revision,
		r.recipe_json,
		r.context_projection,
		r.skill_revision_id,
		r.package_revision_id,
		r.proof_digest,
		r.review_digest,
		r.registration_certificate_json,
		r.validation_policy_version,
		r.created_at,
		r.revalidate_at,
	);
}
export const getHealth = (db: Database, versionId: string) =>
	db
		.query("SELECT * FROM research_route_revision_health WHERE version_id=?")
		.get(versionId) as {
		version_id: string;
		disqualified_at: number;
		reason: string;
	} | null;
export const putHealth = (
	db: Database,
	versionId: string,
	at: number,
	reason: string,
) =>
	db
		.query(
			"INSERT OR IGNORE INTO research_route_revision_health(version_id,disqualified_at,reason) VALUES(?,?,?)",
		)
		.run(versionId, at, reason);

/**
 * CAS for the active pointer. The version must belong to the same epoch/key/incarnation and the
 * key must still be at the expected generation and previous version (no key->version FK exists).
 */
export function activateVersionCas(
	db: Database,
	a: {
		epoch: number;
		key: string;
		incarnation: string;
		generation: number;
		expectedVersionId: string | null;
		versionId: string;
		now: number;
		idleExpiresAt: number;
		/** Edits must not extend the fetch-success time; pass the current value to keep it. */
		lastSuccessAt?: number | null;
	},
): boolean {
	const v = getRevision(db, a.versionId);
	if (
		!v ||
		v.epoch !== a.epoch ||
		v.key !== a.key ||
		v.incarnation !== a.incarnation
	)
		return false;
	return (
		db
			.query(
				`UPDATE research_route_keys SET active_version_id=?,suspension_reason=NULL,retry_after=NULL,
				 control_version=control_version+1,last_success_at=?,idle_expires_at=?,updated_at=?
				 WHERE epoch=? AND key=? AND incarnation=? AND generation=? AND active_version_id IS ?`,
			)
			.run(
				a.versionId,
				a.lastSuccessAt === undefined ? a.now : a.lastSuccessAt,
				a.idleExpiresAt,
				a.now,
				a.epoch,
				a.key,
				a.incarnation,
				a.generation,
				a.expectedVersionId,
			).changes === 1
	);
}

export const updateProof = (
	db: Database,
	id: string,
	from: ProofRow["status"],
	patch: {
		status: ProofRow["status"];
		ticket_id?: string | null;
		report_epoch?: number | null;
		adopted_at?: number | null;
		expires_at?: number;
	},
) =>
	db
		.query(
			`UPDATE research_route_proofs SET status=?,ticket_id=COALESCE(?,ticket_id),report_epoch=COALESCE(?,report_epoch),
			 adopted_at=COALESCE(?,adopted_at),expires_at=COALESCE(?,expires_at) WHERE id=? AND status=?`,
		)
		.run(
			patch.status,
			patch.ticket_id ?? null,
			patch.report_epoch ?? null,
			patch.adopted_at ?? null,
			patch.expires_at ?? null,
			id,
			from,
		).changes === 1;
export const updateDraftContent = (
	db: Database,
	id: string,
	patch: {
		skill_draft?: string | null;
		review_json?: string | null;
		corrections?: number;
	},
	now: number,
) =>
	db
		.query(
			`UPDATE research_route_drafts SET skill_draft=COALESCE(?,skill_draft),review_json=COALESCE(?,review_json),
			 corrections=COALESCE(?,corrections),updated_at=? WHERE id=?`,
		)
		.run(
			patch.skill_draft ?? null,
			patch.review_json ?? null,
			patch.corrections ?? null,
			now,
			id,
		).changes === 1;
export function insertProof(db: Database, p: ProofRow) {
	db.query(
		`INSERT INTO research_route_proofs(id,root_run_id,task_id,ticket_id,report_epoch,epoch,incarnation,key,generation,source_url,binding_json,projection_digest,lookup_provenance_json,validation_policy_version,facts_json,fetched_at,validated_at,adopted_at,status,digest,expires_at)
		 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
	).run(
		p.id,
		p.root_run_id,
		p.task_id,
		p.ticket_id,
		p.report_epoch,
		p.epoch,
		p.incarnation,
		p.key,
		p.generation,
		p.source_url,
		p.binding_json,
		p.projection_digest,
		p.lookup_provenance_json,
		p.validation_policy_version,
		p.facts_json,
		p.fetched_at,
		p.validated_at,
		p.adopted_at,
		p.status,
		p.digest,
		p.expires_at,
	);
}
export const getProof = (db: Database, id: string) =>
	db
		.query("SELECT * FROM research_route_proofs WHERE id=?")
		.get(id) as ProofRow | null;

export function insertDraft(db: Database, d: DraftRow) {
	db.query(
		`INSERT INTO research_route_drafts(id,key,epoch,incarnation,base_generation,base_version_id,origin,proof_id,base_certificate_digest,instruction,skill_draft,review_json,corrections,state,error_code,created_at,updated_at,expires_at)
		 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
	).run(
		d.id,
		d.key,
		d.epoch,
		d.incarnation,
		d.base_generation,
		d.base_version_id,
		d.origin,
		d.proof_id,
		d.base_certificate_digest,
		d.instruction,
		d.skill_draft,
		d.review_json,
		d.corrections,
		d.state,
		d.error_code,
		d.created_at,
		d.updated_at,
		d.expires_at,
	);
}
export const getDraft = (db: Database, id: string) =>
	db
		.query("SELECT * FROM research_route_drafts WHERE id=?")
		.get(id) as DraftRow | null;
/** The single non-terminal draft of an incarnation (UNIQUE partial index), or null. */
export const openDraftOf = (db: Database, incarnation: string) =>
	db
		.query(
			"SELECT * FROM research_route_drafts WHERE incarnation=? AND state IN ('queued','authoring','reviewing')",
		)
		.get(incarnation) as DraftRow | null;
/** Latest draft of a key (any state) for status display. */
export const latestDraftOf = (db: Database, incarnation: string) =>
	db
		.query(
			"SELECT * FROM research_route_drafts WHERE incarnation=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
		)
		.get(incarnation) as DraftRow | null;
export const setDraftState = (
	db: Database,
	id: string,
	from: string[],
	to: string,
	errorCode: string | null,
	now: number,
) =>
	db
		.query(
			`UPDATE research_route_drafts SET state=?,error_code=?,updated_at=? WHERE id=? AND state IN (${from.map(() => "?").join(",")})`,
		)
		.run(to, errorCode, now, id, ...from).changes === 1;
export const terminateOpenDrafts = (
	db: Database,
	incarnation: string,
	to: "interrupted" | "superseded",
	errorCode: string,
	now: number,
) =>
	db
		.query(
			"UPDATE research_route_drafts SET state=?,error_code=?,updated_at=? WHERE incarnation=? AND state IN ('queued','authoring','reviewing')",
		)
		.run(to, errorCode, now, incarnation).changes;

export const getOperation = (db: Database, scope: string, requestId: string) =>
	db
		.query(
			"SELECT * FROM research_route_operations WHERE scope=? AND request_id=?",
		)
		.get(scope, requestId) as OperationRow | null;
export const insertOperation = (db: Database, o: OperationRow) =>
	db
		.query(
			"INSERT INTO research_route_operations(scope,request_id,input_digest,response_json,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?)",
		)
		.run(
			o.scope,
			o.request_id,
			o.input_digest,
			o.response_json,
			o.status,
			o.created_at,
			o.expires_at,
		);

/** UTF-8 stored bytes of the ledger (JSON/text columns only); capabilities' learned bytes are added by the caller. */
export function ledgerBytes(db: Database): number {
	const sum = (sql: string) => (db.query(sql).get() as { n: number }).n;
	return (
		sum(
			"SELECT COALESCE(SUM(LENGTH(CAST(search_spec_json AS BLOB))+LENGTH(CAST(keyword_text AS BLOB))+200),0) n FROM research_route_keys",
		) +
		sum(
			"SELECT COALESCE(SUM(LENGTH(CAST(hits_json AS BLOB))+200),0) n FROM research_search_candidates",
		) +
		sum(
			"SELECT COALESCE(SUM(LENGTH(CAST(recipe_json AS BLOB))+LENGTH(CAST(context_projection AS BLOB))+LENGTH(CAST(registration_certificate_json AS BLOB))+300),0) n FROM research_route_revisions",
		) +
		sum(
			"SELECT COALESCE(SUM(LENGTH(CAST(binding_json AS BLOB))+LENGTH(CAST(facts_json AS BLOB))+LENGTH(CAST(lookup_provenance_json AS BLOB))+300),0) n FROM research_route_proofs",
		) +
		sum(
			"SELECT COALESCE(SUM(LENGTH(CAST(COALESCE(skill_draft,'') AS BLOB))+LENGTH(CAST(COALESCE(review_json,'') AS BLOB))+LENGTH(CAST(COALESCE(instruction,'') AS BLOB))+300),0) n FROM research_route_drafts",
		) +
		sum(
			"SELECT COALESCE(SUM(LENGTH(CAST(response_json AS BLOB))+200),0) n FROM research_route_operations",
		)
	);
}
export const operationRows = (db: Database) =>
	(
		db.query("SELECT COUNT(*) n FROM research_route_operations").get() as {
			n: number;
		}
	).n;

// ---------- T20/T21: operation ledger upkeep, startup recovery, physical reclaim ----------
export const operationBytes = (db: Database) =>
	(
		db
			.query(
				"SELECT COALESCE(SUM(LENGTH(response_json)+200),0) n FROM research_route_operations",
			)
			.get() as { n: number }
	).n;
export const deleteOperation = (
	db: Database,
	scope: string,
	requestId: string,
) =>
	db
		.query(
			"DELETE FROM research_route_operations WHERE scope=? AND request_id=?",
		)
		.run(scope, requestId).changes;
export const deleteExpiredOperations = (
	db: Database,
	now: number,
	limit: number,
) =>
	db
		.query(
			"DELETE FROM research_route_operations WHERE rowid IN (SELECT rowid FROM research_route_operations WHERE expires_at<=? LIMIT ?)",
		)
		.run(now, limit).changes;
/** Terminates every open draft of epochs before `currentEpoch` (global clear). */
export const terminateOpenDraftsBeforeEpoch = (
	db: Database,
	currentEpoch: number,
	errorCode: string,
	now: number,
) =>
	db
		.query(
			"UPDATE research_route_drafts SET state='interrupted',error_code=?,updated_at=? WHERE epoch<? AND state IN ('queued','authoring','reviewing')",
		)
		.run(errorCode, now, currentEpoch).changes;
/** Startup: no job survives a restart, so every open draft is interrupted. */
export const terminateAllOpenDrafts = (
	db: Database,
	errorCode: string,
	now: number,
) =>
	db
		.query(
			"UPDATE research_route_drafts SET state='interrupted',error_code=?,updated_at=? WHERE state IN ('queued','authoring','reviewing')",
		)
		.run(errorCode, now).changes;
/** Keys of epochs before the visible one, oldest first (physical reclaim after clear). */
export const staleEpochKeys = (
	db: Database,
	currentEpoch: number,
	limit: number,
) =>
	db
		.query(
			"SELECT * FROM research_route_keys WHERE epoch<? ORDER BY epoch,key LIMIT ?",
		)
		.all(currentEpoch, limit) as KeyRow[];
export const revisionsOfIncarnation = (db: Database, incarnation: string) =>
	db
		.query("SELECT * FROM research_route_revisions WHERE incarnation=?")
		.all(incarnation) as RevisionRow[];
/**
 * Removes every row of one key incarnation in FK-safe order:
 * draft -> proof -> health -> version -> candidate -> key. Returns row count and freed package ids.
 */
export function deleteKeyTree(db: Database, incarnation: string) {
	const packageIds = revisionsOfIncarnation(db, incarnation).map(
		(r) => r.package_revision_id,
	);
	let rows = 0;
	const run = (sql: string) => {
		rows += db.query(sql).run(incarnation).changes;
	};
	run("DELETE FROM research_route_drafts WHERE incarnation=?");
	run("DELETE FROM research_route_proofs WHERE incarnation=?");
	run(
		"DELETE FROM research_route_revision_health WHERE version_id IN (SELECT version_id FROM research_route_revisions WHERE incarnation=?)",
	);
	run("DELETE FROM research_route_revisions WHERE incarnation=?");
	run("DELETE FROM research_search_candidates WHERE incarnation=?");
	run("DELETE FROM research_route_keys WHERE incarnation=?");
	return { rows, packageIds };
}
