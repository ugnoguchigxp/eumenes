import type { Database } from "bun:sqlite";
import type { ArtifactDefinitionV1, FixedDocument } from "../../capabilities";
import type { DomainAdapter } from "../contracts";
import {
	ActionRequestError,
	isRecord,
	type ArtifactListEntry,
	type ArtifactView,
	type LedgerContext,
	type SourceView,
} from "./action-types";

export type ResolvedArtifact = {
	entry: ArtifactListEntry;
	doc: FixedDocument<ArtifactDefinitionV1>;
	adapter: DomainAdapter;
};

/** The artifact a request may act on: active toolchain, definition present, adapter usable. */
export function resolveArtifact(
	ctx: LedgerContext,
	db: Database,
	artifactRevisionId: string,
): ResolvedArtifact | ActionRequestError {
	const entry = ctx.capabilities
		.artifactsInTransaction(db)
		.find((a) => a.artifactRevisionId === artifactRevisionId);
	if (!entry) return new ActionRequestError("artifact_not_found", 404);
	const adapter = ctx.registry.get(entry.adapterRef);
	if (!adapter || !adapter.availableInTransaction(db))
		return new ActionRequestError("adapter_unavailable", 503);
	const doc = ctx.capabilities.documentInTransaction(db, artifactRevisionId);
	if (
		!doc ||
		!isRecord(doc.document) ||
		doc.document.kind !== "artifact" ||
		!Array.isArray(doc.document.sourceBindings) ||
		!Array.isArray(doc.document.actionBindings)
	)
		return new ActionRequestError("artifact_unavailable", 503);
	return { entry, doc: doc as FixedDocument<ArtifactDefinitionV1>, adapter };
}

export function targetProblem(
	target: "none" | "required" | "optional",
	targetRef: string | undefined,
) {
	if (target === "none" && targetRef !== undefined)
		return new ActionRequestError("target_not_allowed", 400);
	if (target === "required" && targetRef === undefined)
		return new ActionRequestError("target_required", 400);
	return undefined;
}

/** Artifacts whose adapter is usable now: one launcher entry each. */
export function usableArtifacts(
	ctx: LedgerContext,
	db: Database,
): ArtifactListEntry[] {
	return ctx.capabilities.artifactsInTransaction(db).filter((a) => {
		const adapter = ctx.registry.get(a.adapterRef);
		return !!adapter && adapter.availableInTransaction(db);
	});
}

export function artifactView(
	ctx: LedgerContext,
	db: Database,
	artifactRevisionId: string,
): ArtifactView {
	const resolved = resolveArtifact(ctx, db, artifactRevisionId);
	if (resolved instanceof ActionRequestError) throw resolved;
	return {
		artifact: resolved.doc.document,
		artifactRevisionId,
		digest: resolved.doc.digest,
		scopeRef: ctx.scopeRef,
	};
}

/** One registered source of an artifact; the host resolves the query, not the caller. */
export function readSource(
	ctx: LedgerContext,
	db: Database,
	artifactRevisionId: string,
	source: string,
	targetRef?: string,
): SourceView {
	const resolved = resolveArtifact(ctx, db, artifactRevisionId);
	if (resolved instanceof ActionRequestError) throw resolved;
	const binding = resolved.doc.document.sourceBindings.find(
		(s) => s.source === source,
	);
	if (!binding) throw new ActionRequestError("source_not_found", 404);
	if (binding.adapterRef !== resolved.entry.adapterRef)
		throw new ActionRequestError("artifact_unavailable", 503);
	if (!resolved.adapter.describe().queries.has(binding.query))
		throw new ActionRequestError("query_unavailable", 503);
	const problem = targetProblem(binding.target, targetRef);
	if (problem) throw problem;
	const read = resolved.adapter.sourceInTransaction(
		db,
		binding.query,
		targetRef,
	);
	if (!read) throw new ActionRequestError("target_not_found", 404);
	return { revision: read.revision, data: read.data };
}
