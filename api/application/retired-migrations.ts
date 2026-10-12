import type { Migration } from "../infrastructure/sqlite";

/**
 * The research-routes domain (legacy fetch-route learning) was retired on 2026-10-12. Its
 * deployed migration is kept byte-for-byte so applied databases keep their checksum, and a
 * later migration drops its tables. Saved procedures now live in toolchain-history.
 */
const researchRoutesInit = `
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
export const retiredResearchRoutesMigrations: readonly Migration[] = [
	{ id: "research-routes/0001-init", sql: researchRoutesInit },
	{
		id: "research-routes/0002-retired-drop",
		after: ["research-routes/0001-init"],
		sql: `
DROP TABLE IF EXISTS research_route_operations;
DROP TABLE IF EXISTS research_route_drafts;
DROP TABLE IF EXISTS research_route_proofs;
DROP TABLE IF EXISTS research_route_revision_health;
DROP TABLE IF EXISTS research_route_revisions;
DROP TABLE IF EXISTS research_search_candidates;
DROP TABLE IF EXISTS research_route_keys;
DROP TABLE IF EXISTS research_route_state;
`,
	},
];
