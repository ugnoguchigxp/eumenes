import type { Database } from "bun:sqlite";
import { normalize } from "eumenes-agency/agenda";
import { sha256Hex } from "../../infrastructure/digest";
import type { AgencyHostDeps } from "./host-types";
import { recordPrefix, resolveReferences } from "./input";

/** The public-research capability. The catalog and the user's settings are read again at admission. */
export function researchRevision(
	deps: AgencyHostDeps,
	catalog: ReadonlyArray<{
		revisionId: string;
		requiresApproval: boolean;
		effect?: string | null;
	}>,
): string | undefined {
	if (deps.researchRevision) return deps.researchRevision(catalog);
	return catalog.find(
		(card) =>
			!card.requiresApproval &&
			card.revisionId.startsWith("toolchain:web.note@"),
	)?.revisionId;
}

/** The same operation, cited records and permission can be recognized even if the agenda assigned a new item id. */
export function prepareResearch(
	deps: AgencyHostDeps,
	db: Database,
	notes: Parameters<typeof resolveReferences>[2],
	request: { text: string; refs: readonly string[]; delegatedTo?: string },
	seen: readonly string[],
	assignmentRevision?: string,
) {
	const catalog = deps.state?.catalogInTransaction(db) ?? [];
	const revisionId = assignmentRevision ?? researchRevision(deps, catalog);
	const card = catalog.find((entry) => entry.revisionId === revisionId);
	const { input: context, reason } = resolveReferences(deps, db, notes, [
		...request.refs,
		...seen,
	]);
	const policy = deps.settings.inTransaction(db).agency.actions;
	const key = sha256Hex(
		JSON.stringify([
			request.delegatedTo ?? null,
			normalize(request.text),
			[...new Set(request.refs)].sort(),
			context.sources.filter((ref) => ref.startsWith(recordPrefix)).sort(),
			context.complete,
			card?.revisionId,
			card?.requiresApproval,
			policy?.enabled,
		]),
	);
	return { revisionId: card?.revisionId, context, reason, key };
}
