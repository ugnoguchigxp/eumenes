import type { Database } from "bun:sqlite";
import { z } from "zod";
import { canonicalJson, sha256Hex } from "../../infrastructure/digest";
import { decodeLlmJson } from "../../infrastructure/llm-json";
import type { Migration } from "../../infrastructure/sqlite";

export {
	forgetWorkflowWebRoute,
	readWorkflowWebRoute,
	rememberWorkflowWebRoute,
	type WorkflowWebRouteKey,
} from "./workflow-web-routes";

export const migrations: readonly Migration[] = [
	{
		id: "app-development/0001-init",
		after: [
			"ui-compositions/0004-workflow-screens",
			"pipelines/0003-workflow-runs",
		],
		sql: `
CREATE TABLE app_development_works (
 id TEXT PRIMARY KEY, scope TEXT NOT NULL, session_id TEXT NOT NULL UNIQUE, app_id TEXT NOT NULL,
 saved_revision INTEGER NOT NULL, revision INTEGER NOT NULL, draft_json TEXT,
 request TEXT, conversation_id TEXT, busy_run_id TEXT, rejected_json TEXT, updated_at INTEGER NOT NULL
);
CREATE INDEX app_development_works_scope ON app_development_works(scope, updated_at DESC);
CREATE TABLE app_development_versions (
 scope TEXT NOT NULL, app_id TEXT NOT NULL, revision INTEGER NOT NULL, title TEXT NOT NULL,
 draft_json TEXT NOT NULL, digest TEXT NOT NULL, value_json TEXT NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(scope, app_id, revision)
);
CREATE TABLE app_development_receipts (
 scope TEXT NOT NULL, operation_id TEXT NOT NULL, digest TEXT NOT NULL, value_json TEXT NOT NULL,
 PRIMARY KEY(scope, operation_id)
);`,
	},
	{
		id: "app-development/0002-workflow-web-routes",
		after: ["app-development/0001-init"],
		sql: `
CREATE TABLE app_development_web_routes (
 scope TEXT NOT NULL, workflow_id TEXT NOT NULL, revision INTEGER NOT NULL, step_id TEXT NOT NULL,
 target_key TEXT NOT NULL, url TEXT NOT NULL,
 PRIMARY KEY(scope, workflow_id, revision, step_id, target_key)
);`,
	},
];

export const appDraft = z
	.strictObject({
		version: z.literal(1),
		title: z.string().trim().min(1).max(160),
		screen: z
			.strictObject({
				definition: z.json(),
				bindings: z.json().optional(),
			})
			.optional(),
		workflow: z.record(z.string(), z.json()).optional(),
		schemas: z
			.array(
				z.strictObject({
					name: z.string().regex(/^[a-z][a-z0-9-]{0,29}$/),
					schema: z.record(z.string(), z.json()),
				}),
			)
			.max(32)
			.default([]),
	})
	.refine(
		(draft) => draft.screen || draft.workflow,
		"screen or workflow required",
	)
	.refine(
		(draft) => draft.workflow || draft.schemas.length === 0,
		"schemas require workflow",
	);

export type AppDraft = z.infer<typeof appDraft>;
const maxDraftBytes = 96_000;
const json = (value: unknown) =>
	canonicalJson(value, { omitUndefined: true, keyOrder: "codeUnit" });
export const appDigest = (value: unknown) => sha256Hex(json(value));

export function checkAppDraft(text: string) {
	try {
		const result = appDraft.safeParse(decodeLlmJson(text, maxDraftBytes).value);
		return result.success
			? { ok: true as const, value: result.data, fixes: [] }
			: {
					ok: false as const,
					code: "app_definition_invalid",
					fixes: [],
					issues: result.error.issues.slice(0, 8).map((issue) => ({
						path: issue.path.join(".") || "(root)",
						rule: issue.code,
					})),
				};
	} catch {
		return {
			ok: false as const,
			code: "document_parse_failed",
			fixes: [],
			issues: [{ path: "(root)", rule: "json" }],
		};
	}
}

type WorkRow = {
	id: string;
	scope: string;
	session_id: string;
	app_id: string;
	saved_revision: number;
	revision: number;
	draft_json: string | null;
	request: string | null;
	conversation_id: string | null;
	busy_run_id: string | null;
	rejected_json: string | null;
};
type Version = {
	appId: string;
	revision: number;
	title: string;
	digest: string;
	draft: AppDraft;
	workflowRevision: number | null;
	screenRevision: number | null;
	request: string | null;
	conversationId: string | null;
};
const work = (db: Database, scope: string, id: string) =>
	db
		.query<WorkRow, [string, string]>(
			"SELECT * FROM app_development_works WHERE scope=? AND id=?",
		)
		.get(scope, id);
const parsed = <T>(value: string | null) =>
	value === null ? null : (JSON.parse(value) as T);

export function createAppDevelopment(scope: string, now = Date.now) {
	function app(db: Database, id: string, revision?: number) {
		const row = db
			.query<{ value_json: string }, [string, string, number | null]>(
				"SELECT value_json FROM app_development_versions WHERE scope=? AND app_id=? AND revision=COALESCE(?,revision) ORDER BY revision DESC LIMIT 1",
			)
			.get(scope, id, revision ?? null);
		return row ? parsed<Version>(row.value_json) : null;
	}
	function draftOf(db: Database, row: WorkRow) {
		const draft = parsed<AppDraft>(row.draft_json);
		const saved = row.saved_revision
			? app(db, row.app_id, row.saved_revision)
			: null;
		return {
			id: row.id,
			appId: row.app_id,
			sessionId: row.session_id,
			revision: row.revision,
			savedRevision: row.saved_revision,
			draft,
			request: row.request,
			conversationId: row.conversation_id,
			rejected: parsed<unknown>(row.rejected_json),
			busy: row.busy_run_id !== null,
			dirty: !!draft && json(draft) !== json(saved?.draft ?? null),
		};
	}
	const load = (db: Database, id: string) => {
		const row = work(db, scope, id);
		if (!row) throw new Error("work_not_found");
		return row;
	};
	function state(db: Database, row: WorkRow) {
		const view = draftOf(db, row);
		return {
			workRef: view.id,
			savedRef: view.savedRevision ? view.appId : null,
			dirty: view.dirty,
			busy: view.busy,
			revision: view.revision,
			label: view.draft?.title ?? "新しいアプリ",
			current: view.draft,
		};
	}
	return {
		scope,
		app,
		list(db: Database) {
			return db
				.query<{ id: string; title: string; updatedAt: number }, [string]>(
					"SELECT v.app_id AS id,v.title,v.created_at AS updatedAt FROM app_development_versions v WHERE v.scope=? AND v.revision=(SELECT MAX(n.revision) FROM app_development_versions n WHERE n.scope=v.scope AND n.app_id=v.app_id) ORDER BY v.created_at DESC,v.app_id LIMIT 50",
				)
				.all(scope);
		},
		draft(db: Database, id: string) {
			return draftOf(db, load(db, id));
		},
		current(db: Database) {
			const row = db
				.query<WorkRow, [string]>(
					"SELECT * FROM app_development_works WHERE scope=? ORDER BY updated_at DESC,id LIMIT 1",
				)
				.get(scope);
			return row ? draftOf(db, row) : null;
		},
		open(db: Database, input: { sessionId: string; targetRef: string | null }) {
			const prior = db
				.query<WorkRow, [string, string]>(
					"SELECT * FROM app_development_works WHERE scope=? AND session_id=?",
				)
				.get(scope, input.sessionId);
			if (prior) return state(db, prior);
			const saved = input.targetRef ? app(db, input.targetRef) : null;
			if (input.targetRef && !saved) throw new Error("target_not_found");
			const id = crypto.randomUUID();
			db.run(
				"INSERT INTO app_development_works(id,scope,session_id,app_id,saved_revision,revision,draft_json,request,conversation_id,updated_at) VALUES(?,?,?,?,?,0,?,?,?,?)",
				[
					id,
					scope,
					input.sessionId,
					saved?.appId ?? crypto.randomUUID(),
					saved?.revision ?? 0,
					saved ? json(saved.draft) : null,
					saved?.request ?? null,
					saved?.conversationId ?? null,
					now(),
				],
			);
			return state(db, load(db, id));
		},
		state(db: Database, id: string) {
			const row = work(db, scope, id);
			return row ? state(db, row) : null;
		},
		begin(db: Database, id: string, runId: string) {
			const row = load(db, id);
			if (row.busy_run_id && row.busy_run_id !== runId)
				throw new Error("work_busy");
			db.run(
				"UPDATE app_development_works SET busy_run_id=?,updated_at=? WHERE scope=? AND id=?",
				[runId, now(), scope, id],
			);
		},
		endTurn(db: Database, id: string, runId: string) {
			db.run(
				"UPDATE app_development_works SET busy_run_id=NULL,updated_at=? WHERE scope=? AND id=? AND busy_run_id=?",
				[now(), scope, id, runId],
			);
		},
		end(db: Database, id: string, mode: "discard" | "close") {
			const row = work(db, scope, id);
			if (!row) return;
			if (mode === "close" && draftOf(db, row).dirty)
				throw new Error("work_unsaved");
			db.run("DELETE FROM app_development_works WHERE scope=? AND id=?", [
				scope,
				id,
			]);
		},
		commit(
			db: Database,
			id: string,
			input: {
				revision: number;
				value: unknown;
				turn?: {
					sessionId: string;
					runId: string;
					request: string;
					conversationId: string;
				};
			},
		) {
			const row = load(db, id);
			if (
				input.turn
					? row.session_id !== input.turn.sessionId ||
						row.busy_run_id !== input.turn.runId
					: row.busy_run_id !== null
			)
				throw new Error("work_busy");
			if (row.revision !== input.revision) throw new Error("revision_conflict");
			const content = json(appDraft.parse(input.value));
			if (Buffer.byteLength(content) > maxDraftBytes)
				throw new Error("app_definition_too_large");
			if (row.draft_json === content) throw new Error("no_change");
			db.run(
				"UPDATE app_development_works SET draft_json=?,revision=revision+1,request=COALESCE(request,?),conversation_id=COALESCE(conversation_id,?),rejected_json=NULL,updated_at=? WHERE scope=? AND id=?",
				[
					content,
					input.turn?.request ?? null,
					input.turn?.conversationId ?? null,
					now(),
					scope,
					id,
				],
			);
			return { revision: row.revision + 1 };
		},
		reject(
			db: Database,
			id: string,
			input: { text: string; title: string; issues: unknown; fixes: unknown },
		) {
			db.run(
				"UPDATE app_development_works SET rejected_json=? WHERE scope=? AND id=?",
				[
					json({
						...input,
						text: input.text.slice(0, maxDraftBytes),
						createdAt: new Date(now()).toISOString(),
					}),
					scope,
					id,
				],
			);
		},
		publish(
			db: Database,
			input: {
				workRef: string;
				draftRevision: number;
				expectedSavedRevision: number;
				digest: string;
				workflowRevision: number | null;
				screenRevision: number | null;
			},
		) {
			const row = load(db, input.workRef);
			const draft = parsed<AppDraft>(row.draft_json);
			if (!draft || row.busy_run_id) throw new Error("app_draft_unavailable");
			if (
				row.revision !== input.draftRevision ||
				row.saved_revision !== input.expectedSavedRevision ||
				(app(db, row.app_id)?.revision ?? 0) !== input.expectedSavedRevision
			)
				throw new Error("revision_conflict");
			const value: Version = {
				appId: row.app_id,
				revision: row.saved_revision + 1,
				title: draft.title,
				draft,
				digest: input.digest,
				workflowRevision: input.workflowRevision,
				screenRevision: input.screenRevision,
				request: row.request,
				conversationId: row.conversation_id,
			};
			db.run("INSERT INTO app_development_versions VALUES(?,?,?,?,?,?,?,?)", [
				scope,
				value.appId,
				value.revision,
				value.title,
				row.draft_json,
				value.digest,
				json(value),
				now(),
			]);
			db.run(
				"UPDATE app_development_works SET saved_revision=?,revision=revision+1,updated_at=? WHERE scope=? AND id=?",
				[value.revision, now(), scope, row.id],
			);
			return value;
		},
		receipt(db: Database, operationId: string) {
			const row = db
				.query<{ digest: string; value_json: string }, [string, string]>(
					"SELECT digest,value_json FROM app_development_receipts WHERE scope=? AND operation_id=?",
				)
				.get(scope, operationId);
			return row
				? {
						digest: row.digest,
						value: JSON.parse(row.value_json) as Record<string, unknown>,
					}
				: null;
		},
		saveReceipt(
			db: Database,
			operationId: string,
			digest: string,
			value: Record<string, unknown>,
		) {
			db.run("INSERT INTO app_development_receipts VALUES(?,?,?,?)", [
				scope,
				operationId,
				digest,
				json(value),
			]);
		},
	};
}

export type AppDevelopment = ReturnType<typeof createAppDevelopment>;
