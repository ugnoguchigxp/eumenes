import type { Database } from "bun:sqlite";
import {
	buildProjection,
	type CanonicalHasher,
	type Entity,
	type ProjectionEntry,
	type ScopeRef,
} from "eumenes-world-model";
import { listEntities } from "eumenes-world-model/sqlite";
import { sha256Hex } from "../../../infrastructure/digest";
import type { WorldService } from "./world-service";

/** Most entities the Scope digest reads at once (the package's list limit). */
const LIST_LIMIT = 500;
/** One id list per `listEntities` call (the package's limit). */
const IDS_PER_CALL = 500;

export type ListedEntity = {
	id: string;
	revision: number;
	displayName: string;
	aliases: readonly string[];
};

/** Reads of the Scope's entities and live claims, through the package's public API only. */
export function createReads(deps: {
	world: WorldService;
	purpose: string;
	now: () => number;
	hasher: CanonicalHasher;
	accessOf: (
		db: Database,
		scope: ScopeRef,
	) => ReturnType<WorldService["accessInTransaction"]>;
}) {
	const { world, purpose, now, hasher, accessOf } = deps;

	const listRequest = (
		db: Database,
		scope: ScopeRef,
		query: { aliasPrefix?: string; ids?: readonly string[] } | undefined,
		limit: number,
	) => ({
		contractVersion: 1,
		access: accessOf(db, scope),
		scopeKey: scope.scopeKey,
		...(query === undefined ? {} : { query }),
		limit,
	});

	/** Entities whose name or alias starts with the prefix; null when World can not answer. */
	function entitiesByPrefix(
		db: Database,
		scope: ScopeRef,
		aliasPrefix: string,
		limit: number,
	): ListedEntity[] | null {
		const result = listEntities(
			db,
			listRequest(db, scope, { aliasPrefix }, limit),
		);
		// A prefix World finds unusable (too long, for one) names nothing.
		if (result.status === "rejected") return [];
		return result.status === "ready" ? [...result.entities] : null;
	}

	/** The named live entities (an absorbed member is answered by its representative). */
	function entitiesByIds(
		db: Database,
		scope: ScopeRef,
		ids: readonly string[],
	): ListedEntity[] | null {
		const out: ListedEntity[] = [];
		for (let i = 0; i < ids.length; i += IDS_PER_CALL) {
			const result = listEntities(
				db,
				listRequest(
					db,
					scope,
					{ ids: ids.slice(i, i + IDS_PER_CALL) },
					IDS_PER_CALL,
				),
			);
			if (result.status !== "ready") return null;
			out.push(...result.entities);
		}
		return out;
	}

	/**
	 * Identity of the Scope's live entities (ids and revisions): a window that was held is offered
	 * again only when this changes, because only a changed entity set can resolve what was held.
	 * World lists one page only (in id order); beyond it the digest also follows the forget epoch and
	 * the entity operations applied, so a change past the page still changes it.
	 */
	function entityDigest(db: Database, scope: ScopeRef): string | null {
		const result = listEntities(
			db,
			listRequest(db, scope, undefined, LIST_LIMIT),
		);
		if (result.status !== "ready") return null;
		return sha256Hex(
			JSON.stringify([
				"world-curation-entities/1",
				result.truncated
					? [world.forgetEpoch(db, scope), world.entityGeneration()]
					: null,
				result.entities.map((e) => [e.id, e.revision]),
			]),
		);
	}

	/** The live claims of the Scope (one bounded snapshot), or null when World can not answer. */
	function liveClaims(
		db: Database,
		scope: ScopeRef,
	): { entries: readonly ProjectionEntry[]; complete: boolean } | null {
		const asOf = now();
		const read = world.readSnapshot(db, {
			access: {
				principal: scope.principal,
				scopeKeys: [scope.scopeKey],
				purpose,
			},
			scope,
			asOf,
		});
		if (read.status !== "ready") return null;
		const projection = buildProjection(
			{ contractVersion: 1, snapshot: read.snapshot },
			hasher,
		);
		if (!projection.ok) return null;
		return {
			entries: projection.value.entries,
			complete: !read.coverage.partial && read.snapshot.complete,
		};
	}

	const entityOf = (scope: ScopeRef, e: ListedEntity): Entity => ({
		id: e.id,
		scope,
		revision: e.revision,
		displayName: e.displayName,
		aliases: [...e.aliases],
		externalRefs: [],
	});

	return {
		entitiesByPrefix,
		entitiesByIds,
		entityDigest,
		liveClaims,
		entityOf,
	};
}
