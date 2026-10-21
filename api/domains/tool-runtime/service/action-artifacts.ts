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
	/** Every adapter its sources (and toolchain binding) name; all registered and available. */
	adapters: ReadonlyMap<string, DomainAdapter>;
};

/** The artifact definition when it is a complete artifact document, else undefined. */
function definitionOf(
	ctx: LedgerContext,
	db: Database,
	artifactRevisionId: string,
): FixedDocument<ArtifactDefinitionV1> | undefined {
	const doc = ctx.capabilities.documentInTransaction(db, artifactRevisionId);
	if (
		!doc ||
		!isRecord(doc.document) ||
		doc.document.kind !== "artifact" ||
		!Array.isArray(doc.document.sourceBindings) ||
		!Array.isArray(doc.document.actionBindings)
	)
		return undefined;
	return doc as FixedDocument<ArtifactDefinitionV1>;
}

/** The adapters an artifact needs, or undefined when one is unregistered or unavailable. */
function usableAdapters(
	ctx: LedgerContext,
	db: Database,
	entry: ArtifactListEntry,
	doc: ArtifactDefinitionV1,
): Map<string, DomainAdapter> | undefined {
	const refs = new Set(doc.sourceBindings.map((s) => s.adapterRef));
	if (entry.adapterRef) refs.add(entry.adapterRef);
	const adapters = new Map<string, DomainAdapter>();
	for (const ref of refs) {
		const adapter = ctx.registry.get(ref);
		if (
			!adapter ||
			!(
				adapter.artifactAvailableInTransaction?.(db) ??
				adapter.availableInTransaction(db)
			)
		)
			return undefined;
		adapters.set(ref, adapter);
	}
	return adapters;
}

/**
 * The artifact a request may act on: published (toolchain or launcher), definition present,
 * and every adapter its sources name registered and available.
 */
export function resolveArtifact(
	ctx: LedgerContext,
	db: Database,
	artifactRevisionId: string,
): ResolvedArtifact | ActionRequestError {
	const entry = ctx.capabilities
		.artifactsInTransaction(db)
		.find((a) => a.artifactRevisionId === artifactRevisionId);
	if (!entry) return new ActionRequestError("artifact_not_found", 404);
	const doc = definitionOf(ctx, db, artifactRevisionId);
	if (!doc) return new ActionRequestError("artifact_unavailable", 503);
	const adapters = usableAdapters(ctx, db, entry, doc.document);
	if (!adapters) return new ActionRequestError("adapter_unavailable", 503);
	return { entry, doc, adapters };
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

/** Artifacts whose adapters are all usable now: toolchain artifacts and launchers. */
export function usableArtifacts(
	ctx: LedgerContext,
	db: Database,
): ArtifactListEntry[] {
	return ctx.capabilities.artifactsInTransaction(db).flatMap((entry) => {
		const doc = definitionOf(ctx, db, entry.artifactRevisionId);
		return doc && usableAdapters(ctx, db, entry, doc.document)
			? [{ ...entry, launcher: entry.launcher ?? null }]
			: [];
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

/** Read parameters are accepted only for sources that register a schema, and are validated. */
function validParams(
	ctx: LedgerContext,
	db: Database,
	schemaRef: string | undefined,
	params: unknown,
): unknown {
	if (params === undefined) return undefined;
	if (!schemaRef) throw new ActionRequestError("invalid_params", 400);
	const schema = ctx.capabilities.schemaInTransaction(db, schemaRef);
	if (!schema) throw new ActionRequestError("schema_unavailable", 503);
	const parsed = schema.safeParse(params);
	if (!parsed.success) throw new ActionRequestError("invalid_params", 400);
	return parsed.data;
}

/** One registered source of an artifact; the host resolves the query, not the caller. */
export function readSource(
	ctx: LedgerContext,
	db: Database,
	artifactRevisionId: string,
	source: string,
	targetRef?: string,
	/** Parsed `params` of the request; undefined when the client sent none. */
	params?: unknown,
): SourceView {
	const resolved = resolveArtifact(ctx, db, artifactRevisionId);
	if (resolved instanceof ActionRequestError) throw resolved;
	const binding = resolved.doc.document.sourceBindings.find(
		(s) => s.source === source,
	);
	if (!binding) throw new ActionRequestError("source_not_found", 404);
	const adapter = resolved.adapters.get(binding.adapterRef);
	if (!adapter) throw new ActionRequestError("adapter_unavailable", 503);
	if (!adapter.describe().queries.has(binding.query))
		throw new ActionRequestError("query_unavailable", 503);
	const problem = targetProblem(binding.target, targetRef);
	if (problem) throw problem;
	const read = adapter.sourceInTransaction(
		db,
		binding.query,
		targetRef,
		validParams(ctx, db, binding.paramsSchemaRef, params),
	);
	if (!read) throw new ActionRequestError("target_not_found", 404);
	return { revision: read.revision, data: read.data };
}
