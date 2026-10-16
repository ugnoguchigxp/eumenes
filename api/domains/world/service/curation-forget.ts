import type { Database } from "bun:sqlite";
import type { ScopeRef } from "eumenes-world-model";
import {
	CONVERSATION_SOURCE_KIND,
	CONVERSATION_SOURCE_NAMESPACE,
	CONVERSATION_SOURCE_REPRESENTATION,
} from "../../conversation";
import type { ForgetRoot } from "../repository/lifecycle";
import { CurationError, type CurationCtx } from "./curation-ctx";
import type {
	ClaimForgetResult,
	EntityForgetResult,
	EvidenceMessages,
	ForgetNothing,
	SourceForgetRequest,
	ForgetAccepted,
} from "./curation-types";
import { sourceKeyOf } from "./inputs";
import { rootDigest } from "./lifecycle-shared";

/** Revisions World returns for one assertion in a history read. */
const HISTORY_LIMIT = 100;
/** Most subjects one focused snapshot read may name. */
const FOCUS_SUBJECTS = 100;

const unique = (ids: readonly string[]) => [...new Set(ids)].sort();

/**
 * The forget operations the steward calls (steward plan F1, F3, F4, F7). A forget here is only
 * the durable intake in the caller's transaction; the caller resumes it after that transaction
 * committed (`lifecycle.resumeForget(forgetId)`), so `accepted` is never `complete`.
 */
export function createForget(ctx: CurationCtx) {
	const { world, lifecycle, purpose, now } = ctx;

	function accept(
		db: Database,
		scope: ScopeRef,
		idPrefix: "sb" | "sc" | "se",
		reasonCode: "SOURCE_FORGOTTEN" | "FORGET_REQUESTED",
		roots: readonly ForgetRoot[],
	): ForgetAccepted {
		const forgetId = `${idPrefix}-${rootDigest(roots).slice(0, 32)}`;
		const accepted = lifecycle.acceptForgetInTransaction(db, {
			forgetId,
			scope,
			reasonCode,
			roots,
			origin: "steward",
		});
		if ("status" in accepted)
			throw new CurationError(`forget_${accepted.reasonCode.toLowerCase()}`);
		return { status: "accepted", forgetId };
	}

	const access = (scope: ScopeRef) => ({
		principal: scope.principal,
		scopeKeys: [scope.scopeKey],
		purpose,
	});

	return {
		/** Messages the steward put on the exclusion ledger leave World as forgotten sources. */
		acceptSourceForgetInTransaction(
			db: Database,
			request: SourceForgetRequest,
		): ForgetAccepted | ForgetNothing {
			const ids = unique(request.messageIds);
			if (ids.length === 0) return { status: "nothing" };
			return accept(
				db,
				request.scope,
				"sb",
				// The package knows one tombstone reason for a source that must not be used any more.
				"SOURCE_FORGOTTEN",
				ids.map((id) => ({
					kind: "source" as const,
					id: sourceKeyOf({
						namespace: CONVERSATION_SOURCE_NAMESPACE,
						kind: CONVERSATION_SOURCE_KIND,
						id,
						representation: CONVERSATION_SOURCE_REPRESENTATION,
					}),
					revision: 1,
				})),
			);
		},

		/** Every revision of these claims. */
		forgetClaimsInTransaction(
			db: Database,
			input: { scope: ScopeRef; claimIds: readonly string[] },
		): ClaimForgetResult {
			const ids = unique(input.claimIds);
			if (ids.length === 0) return { status: "nothing" };
			const roots: ForgetRoot[] = [];
			const found: string[] = [];
			const missing: string[] = [];
			for (const id of ids) {
				const history = world.readHistory(db, {
					access: access(input.scope),
					scope: input.scope,
					assertionId: id,
					limit: HISTORY_LIMIT,
				});
				// A claim that is already forgotten is gone: nothing to do for it.
				if (history.status === "blocked" && history.reasonCode !== "TOMBSTONED")
					return { status: "unavailable", reason: history.reasonCode };
				const revisions =
					history.status === "ready"
						? history.revisions.map((r) => r.revision)
						: [];
				if (revisions.length === 0) {
					missing.push(id);
					continue;
				}
				found.push(id);
				for (let revision = 1; revision <= Math.max(...revisions); revision++)
					roots.push({ kind: "assertion", id, revision });
			}
			if (found.length === 0) return { status: "nothing" };
			return {
				...accept(db, input.scope, "sc", "FORGET_REQUESTED", roots),
				claimIds: found,
				missing,
			};
		},

		/** The entities with everything that stands on them (the package reaches relations and merged members). */
		forgetEntitiesInTransaction(
			db: Database,
			input: { scope: ScopeRef; entityIds: readonly string[] },
		): EntityForgetResult {
			const ids = unique(input.entityIds);
			if (ids.length === 0) return { status: "nothing" };
			const listed = ctx.entitiesByIds(db, input.scope, ids);
			if (listed === null)
				return { status: "unavailable", reason: "world_unavailable" };
			const live = new Set(listed.map((e) => e.id));
			const found = ids.filter((id) => live.has(id));
			if (found.length === 0) return { status: "nothing" };
			return {
				...accept(
					db,
					input.scope,
					"se",
					"FORGET_REQUESTED",
					found.map((id) => ({ kind: "entity" as const, id, revision: 1 })),
				),
				entityIds: found,
				missing: ids.filter((id) => !live.has(id)),
			};
		},

		/**
		 * The conversation messages standing as evidence of these claims (every revision) and of
		 * every claim about these entities. Read BEFORE the forget: afterwards the evidence is gone.
		 */
		evidenceMessagesOf(
			db: Database,
			input: {
				scope: ScopeRef;
				claimIds: readonly string[];
				entityIds: readonly string[];
			},
		): EvidenceMessages {
			const claims = new Set(input.claimIds);
			let complete = true;
			const entities = unique(input.entityIds);
			for (let i = 0; i < entities.length; i += FOCUS_SUBJECTS) {
				const focus = entities.slice(i, i + FOCUS_SUBJECTS);
				const read = world.readSnapshot(db, {
					access: access(input.scope),
					scope: input.scope,
					asOf: now(),
					focus: { subjectIds: focus, depth: 1 },
				});
				if (read.status !== "ready")
					return {
						status: "unavailable",
						reason: read.reasonCode,
					};
				complete &&= read.snapshot.complete && !read.coverage.partial;
				const named = new Set(focus);
				for (const assertion of read.snapshot.assertions)
					if (
						named.has(assertion.subjectId) ||
						(assertion.payload.kind === "relation" &&
							named.has(assertion.payload.objectId))
					)
						claims.add(assertion.id);
			}
			const messageIds = new Set<string>();
			for (const id of claims) {
				const history = world.readHistory(db, {
					access: access(input.scope),
					scope: input.scope,
					assertionId: id,
					limit: HISTORY_LIMIT,
				});
				if (history.status === "blocked" && history.reasonCode !== "TOMBSTONED")
					return { status: "unavailable", reason: history.reasonCode };
				if (history.status !== "ready") continue;
				complete &&= !history.truncated;
				for (const revision of history.revisions)
					for (const evidence of revision.evidence)
						if (
							evidence.source.namespace === CONVERSATION_SOURCE_NAMESPACE &&
							evidence.source.kind === CONVERSATION_SOURCE_KIND
						)
							messageIds.add(evidence.source.id);
			}
			return { status: "ok", messageIds: [...messageIds].sort(), complete };
		},

		/** World's forget epoch of the Scope: a result prepared under another epoch must not be adopted. */
		forgetEpochInTransaction: (db: Database, scope: ScopeRef): string =>
			world.forgetEpoch(db, scope),
	};
}
