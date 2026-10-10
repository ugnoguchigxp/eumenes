import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import {
	type ClearResponse,
	type RouteDTO,
	type RouteSummaryDTO,
	canonicalJson,
	clearBody,
	controlBody,
	cursorPayload,
	editBody,
	keyParam,
	limits,
	listQuery,
	ownerScope,
	routeRecipe,
	searchSpec,
	sha256,
	ttl,
} from "../contracts";
import * as repo from "../repository";
import type { EditResult } from ".";
import { type Clock, deriveState, stateTokenOf, systemClock } from "./registry";
import type { ControlResult } from "./plans";

export type ApiResult = { status: number; body: unknown };
export type SkillReader = (
	db: Database,
	revisionId: string,
) => { hash: string; body: string | null } | null;
/** Commit-time facts for the application (release grants, publish SSE invalidation). */
export type RouteChange =
	| { type: "disabled" | "rediscovered"; key: string; incarnation: string }
	| { type: "edit_accepted"; key: string; draftId: string }
	| { type: "cleared"; epoch: number };

/** Transactional operations this API layer composes; satisfied by the routes service. */
export type OperationsRoutes = {
	editInTransaction(
		db: Database,
		input: { key: string; expectedStateToken: string; instruction: string },
	): EditResult;
	disableInTransaction(
		db: Database,
		input: { key: string; expectedStateToken: string },
	): ControlResult;
	rediscoverInTransaction(
		db: Database,
		input: { key: string; expectedStateToken: string },
	): ControlResult;
	enqueueSweepInTransaction?(
		db: Database,
		input: { mode: "ttl" | "epoch" },
	): void;
};
export type OperationsDeps = {
	routes: OperationsRoutes;
	store: Pick<SqliteStore, "read" | "write">;
	clock?: Clock;
	scope?: string;
	skills?: SkillReader;
	onChange?: (changes: RouteChange[]) => void;
};

const b64 = (v: unknown) =>
	Buffer.from(JSON.stringify(v)).toString("base64url");
const unb64 = (s: string) =>
	JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as unknown;
const ok = (body: unknown, status = 200): ApiResult => ({ status, body });
const err = (status: number, error: string): ApiResult => ({
	status,
	body: { error },
});

type Outcome = ApiResult & { persist?: boolean };

export function createOperations(deps: OperationsDeps) {
	const clock = deps.clock ?? systemClock;
	const scope = deps.scope ?? ownerScope;

	function summary(db: Database, k: repo.KeyRow, now: number): RouteSummaryDTO {
		const spec = searchSpec.safeParse(JSON.parse(k.search_spec_json));
		const version = k.active_version_id
			? repo.getRevision(db, k.active_version_id)
			: null;
		const recipe = version
			? routeRecipe.safeParse(JSON.parse(version.recipe_json))
			: null;
		const draft = repo.latestDraftOf(db, k.incarnation);
		return {
			key: k.key,
			keywords: k.keyword_text,
			target: (spec.success
				? spec.data.target
				: {}) as RouteSummaryDTO["target"],
			state: deriveState(db, k, now),
			stateToken: stateTokenOf(k),
			activeVersionId: k.active_version_id,
			sourceUrl: recipe?.success ? recipe.data.sourceUrl : null,
			lastSuccessAt: k.last_success_at ?? version?.created_at ?? null,
			draftStatus: draft
				? {
						id: draft.id,
						state: draft.state as never,
						errorCode: draft.error_code,
					}
				: null,
		};
	}
	/** Bodies are exposed only while the route is actually usable; everything else is null. */
	function detail(db: Database, k: repo.KeyRow, now: number): RouteDTO {
		const s = summary(db, k, now);
		const version =
			s.state === "active" && k.active_version_id
				? repo.getRevision(db, k.active_version_id)
				: null;
		const skill =
			version && deps.skills
				? deps.skills(db, version.skill_revision_id)
				: null;
		return {
			...s,
			skillRevision: version
				? skill
					? {
							revisionId: version.skill_revision_id,
							hash: skill.hash,
							body: skill.body,
						}
					: deps.skills
						? null
						: null
				: null,
			contextProjection: version ? version.context_projection : null,
		};
	}

	function list(query: unknown): ApiResult {
		const q = listQuery.safeParse(query);
		if (!q.success) return err(400, "invalid_query");
		let after: string | null = null;
		const epochNow = deps.store.read((db) => repo.getEpoch(db));
		if (q.data.cursor !== undefined) {
			let c: ReturnType<typeof cursorPayload.safeParse>;
			try {
				c = cursorPayload.safeParse(unb64(q.data.cursor));
			} catch {
				return err(400, "invalid_cursor");
			}
			if (!c.success || c.data.scope !== scope)
				return err(400, "invalid_cursor");
			if (c.data.epoch !== epochNow) return err(409, "stale_cursor");
			after = c.data.lastKey;
		}
		return deps.store.read((db) => {
			const epoch = repo.getEpoch(db);
			if (epoch !== epochNow) return err(409, "stale_cursor");
			const rows = repo.listKeys(db, epoch, after, q.data.limit + 1);
			const page = rows.slice(0, q.data.limit);
			const now = clock.now();
			return ok({
				items: page.map((k) => summary(db, k, now)),
				nextCursor:
					rows.length > q.data.limit
						? b64({ lastKey: page.at(-1)!.key, epoch, scope })
						: null,
				epoch,
			});
		});
	}

	function show(key: string): ApiResult {
		if (!keyParam.safeParse(key).success) return err(400, "invalid_key");
		return deps.store.read((db) => {
			const k = repo.getKey(db, repo.getEpoch(db), key);
			return k ? ok(detail(db, k, clock.now())) : err(404, "not_found");
		});
	}

	/**
	 * Common POST receipt handling: replay returns the stored status/body, a different body under the
	 * same requestId is 409, no room for a receipt is 429 before any change. State change and receipt
	 * are written by the same transaction.
	 */
	async function mutate(input: {
		method: "POST";
		path: string;
		requestId: string;
		body: unknown;
		run: (db: Database, changes: RouteChange[]) => Outcome;
	}): Promise<ApiResult> {
		const changes: RouteChange[] = [];
		const result = await deps.store.write((db): ApiResult => {
			const now = clock.now();
			const digest = sha256(
				canonicalJson({
					method: input.method,
					path: input.path,
					body: input.body,
				}),
			);
			const prev = repo.getOperation(db, scope, input.requestId);
			if (prev && prev.expires_at > now)
				return prev.input_digest === digest
					? { status: prev.status, body: JSON.parse(prev.response_json) }
					: err(409, "request_conflict");
			if (prev) repo.deleteOperation(db, scope, input.requestId);
			const full = () =>
				repo.operationRows(db) >= limits.operationRowsMax ||
				repo.operationBytes(db) >= limits.operationBytesMax;
			if (full()) {
				repo.deleteExpiredOperations(db, now, limits.sweepLimit);
				if (full()) return err(429, "control_busy");
			}
			const out = input.run(db, changes);
			if (out.persist !== false && out.status < 500 && out.status !== 429)
				repo.insertOperation(db, {
					scope,
					request_id: input.requestId,
					input_digest: digest,
					response_json: JSON.stringify(out.body),
					status: out.status,
					created_at: now,
					expires_at: now + ttl.operationMs,
				});
			else changes.length = 0;
			return { status: out.status, body: out.body };
		});
		if (result.status < 400 && changes.length) deps.onChange?.(changes);
		return result;
	}

	const controlOutcome = (
		db: Database,
		key: string,
		r: ControlResult,
		type: "disabled" | "rediscovered",
		changes: RouteChange[],
	): Outcome => {
		if (r.kind === "not_found") return err(404, "not_found");
		if (r.kind === "conflict") return err(409, "stale_state_token");
		const k = repo.getKey(db, repo.getEpoch(db), key)!;
		changes.push({ type, key, incarnation: k.incarnation });
		return ok(detail(db, k, clock.now()));
	};

	async function edit(key: string, input: unknown): Promise<ApiResult> {
		if (!keyParam.safeParse(key).success) return err(400, "invalid_key");
		const b = editBody.safeParse(input);
		if (!b.success) return err(400, "invalid_input");
		return mutate({
			method: "POST",
			path: `/api/research-routes/${key}/edits`,
			requestId: b.data.requestId,
			body: b.data,
			run: (db) => {
				const r = deps.routes.editInTransaction(db, {
					key,
					expectedStateToken: b.data.expectedStateToken,
					instruction: b.data.instruction,
				});
				switch (r.kind) {
					case "not_found":
						return err(404, "not_found");
					case "conflict":
						return err(409, r.code);
					case "not_editable":
						return err(409, "route_not_editable");
				}
			},
		});
	}

	function control(kind: "disable" | "rediscover") {
		return async (key: string, input: unknown): Promise<ApiResult> => {
			if (!keyParam.safeParse(key).success) return err(400, "invalid_key");
			const b = controlBody.safeParse(input);
			if (!b.success) return err(400, "invalid_input");
			return mutate({
				method: "POST",
				path: `/api/research-routes/${key}/${kind}`,
				requestId: b.data.requestId,
				body: b.data,
				run: (db, changes) => {
					const args = { key, expectedStateToken: b.data.expectedStateToken };
					return kind === "disable"
						? controlOutcome(
								db,
								key,
								deps.routes.disableInTransaction(db, args),
								"disabled",
								changes,
							)
						: controlOutcome(
								db,
								key,
								deps.routes.rediscoverInTransaction(db, args),
								"rediscovered",
								changes,
							);
				},
			});
		};
	}

	async function clear(input: unknown): Promise<ApiResult> {
		const b = clearBody.safeParse(input);
		if (!b.success) return err(400, "invalid_input");
		return mutate({
			method: "POST",
			path: "/api/research-routes/clear",
			requestId: b.data.requestId,
			body: b.data,
			run: (db, changes) => {
				const epoch = repo.getEpoch(db);
				if (b.data.expectedEpoch !== epoch) return err(409, "stale_epoch");
				const deletedKeys = repo.countKeys(db, epoch);
				const next = repo.bumpEpoch(db);
				repo.terminateOpenDraftsBeforeEpoch(
					db,
					next,
					"route_cleared",
					clock.now(),
				);
				try {
					deps.routes.enqueueSweepInTransaction?.(db, { mode: "epoch" });
				} catch {
					// Reclaim is retried by the hourly sweep; the clear itself must not fail.
				}
				changes.push({ type: "cleared", epoch: next });
				return ok({ epoch: next, deletedKeys } satisfies ClearResponse);
			},
		});
	}

	return {
		list,
		show,
		edit,
		disable: control("disable"),
		rediscover: control("rediscover"),
		clear,
	};
}
export type RouteOperations = ReturnType<typeof createOperations>;
