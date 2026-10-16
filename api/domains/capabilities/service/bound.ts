import type { Database } from "bun:sqlite";
import {
	bytes,
	validators,
	type Definition,
	type FixedDefinition,
	type Owner,
	type Prepared,
} from "../contracts";
import { getDocument } from "../repository";
import { createBundles } from "./bundles";
import { schemaInTransaction } from "./documents";
import { zSchema } from "./schema";

/** Check the input against the package's schema (or a named tool's) and bound the context. */
export function finishPrepare(
	all: FixedDefinition[],
	input: unknown,
	schemaKey?: keyof typeof validators,
): Prepared {
	const pack = all[0]!;
	if (pack.kind !== "package" || !pack.schemaKey)
		throw new Error("invalid_capability");
	const parsed = validators[schemaKey ?? pack.schemaKey].safeParse(input);
	if (!parsed.success) throw new Error("invalid_capability_input");
	const dependencies = all.slice(1);
	const required = dependencies.map(
		(d) => d.body ?? (d.schemaKey ? zSchema(d.schemaKey) : ""),
	);
	if (
		dependencies.filter((d) => d.kind === "skill").length > 4 ||
		bytes(required) > 16384
	)
		throw new Error("required_context_overflow");
	return { package: pack, dependencies, input: parsed.data };
}

/** Exact-revision preparation, stored documents and bundle import. */
export function createBound(deps: {
	closure: (db: Database, revisionId: string) => FixedDefinition[];
	register: (db: Database, d: Definition) => void;
	now: () => number;
}) {
	const { closure } = deps;
	/** The closure of an exact active package revision, checked against what the caller froze. */
	function activeClosure(
		db: Database,
		owner: Owner,
		revisionId: string,
		expect?: { hash?: string; generation?: number },
	) {
		if (!owner?.taskId || !owner.rootRunId)
			throw new Error("capability_ref_invalid");
		const item = db
			.query(
				"SELECT i.active_revision_id FROM capability_revisions r JOIN capability_items i ON i.key=r.item_key WHERE r.id=?",
			)
			.get(revisionId) as { active_revision_id: string } | null;
		if (!item || item.active_revision_id !== revisionId)
			throw new Error("capability_unavailable");
		const all = closure(db, revisionId);
		if (
			(expect?.hash !== undefined && all[0]!.hash !== expect.hash) ||
			(expect?.generation !== undefined &&
				all[0]!.generation !== expect.generation)
		)
			throw new Error("capability_revoked");
		return all;
	}
	/** Prepare an exact active package revision without candidate search. Same checks as prepare. */
	function prepareActiveByIdInTransaction(
		db: Database,
		owner: Owner,
		revisionId: string,
		input: unknown,
		expect?: { hash?: string; generation?: number },
	): Prepared {
		return finishPrepare(activeClosure(db, owner, revisionId, expect), input);
	}
	/**
	 * Prepare one tool of an exact active package: the input is checked against that tool's own
	 * schema, not the package's. Bound toolchains run their operations through this.
	 */
	function prepareBoundInTransaction(
		db: Database,
		owner: Owner,
		packageRevisionId: string,
		toolRevisionId: string,
		input: unknown,
		expect?: { hash?: string; generation?: number },
	): Prepared {
		const all = activeClosure(db, owner, packageRevisionId, expect);
		const tool = all.find(
			(d) => d.kind === "tool" && d.revisionId === toolRevisionId,
		);
		if (!tool?.schemaKey || !all[0]!.toolRevisionIds?.includes(toolRevisionId))
			throw new Error("invalid_capability");
		return finishPrepare(all, input, tool.schemaKey);
	}

	const bundles = createBundles({ register: deps.register, now: deps.now });
	/** A stored binding, artifact or schema revision. */
	function documentInTransaction(db: Database, revisionId: string) {
		const stored = getDocument(db, revisionId);
		return stored
			? {
					revisionId: stored.revisionId,
					digest: stored.digest,
					document: stored.document,
				}
			: null;
	}
	return {
		seedBundlesInTransaction: bundles.seedBundlesInTransaction,
		api: {
			activePackageRevisionInTransaction(db: Database, id: string): string {
				const row = db
					.query(
						"SELECT active_revision_id FROM capability_items WHERE kind='package' AND id=? AND enabled=1",
					)
					.get(id) as { active_revision_id: string } | null;
				if (!row) throw new Error("capability_unavailable");
				return row.active_revision_id;
			},
			prepareActiveByIdInTransaction,
			prepareBoundInTransaction,
			documentInTransaction,
			schemaInTransaction,
			importBundleInTransaction: bundles.importBundleInTransaction,
		},
	};
}
