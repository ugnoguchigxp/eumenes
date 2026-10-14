import type { Database } from "bun:sqlite";
import type {
	ArtifactDefinitionV1,
	CommandBindingV1,
	FixedDefinition,
	FixedDocument,
} from "../contracts";
import {
	artifactPointers,
	clearArtifactPointer,
	getDocument,
	setArtifactPointer,
} from "../repository";
import { artifactInTransaction } from "./documents";

/** One artifact offered for opening: through a toolchain, on its own, or both. */
export type ArtifactEntry = {
	artifactId: string;
	artifactRevisionId: string;
	title: string;
	/** The toolchain that references the artifact, or null for a standalone launcher artifact. */
	toolchainId: string | null;
	toolchainRevisionId: string | null;
	/** The adapter that executes the toolchain's binding; null for a standalone artifact. */
	adapterRef: string | null;
	/** Every adapter the artifact's sources (and binding) need; all must be available. */
	adapterRefs: string[];
	launcher?: NonNullable<ArtifactDefinitionV1["launcher"]>;
};

const unique = (values: string[]) => [...new Set(values)];

/** The artifact revisions of every enabled toolchain's active revision (no availability check). */
function toolchainArtifactIds(db: Database) {
	return (
		db
			.query(
				"SELECT json_extract(r.definition_json,'$.artifactRevisionId') a FROM capability_items i JOIN capability_revisions r ON r.id=i.active_revision_id WHERE i.kind='toolchain' AND i.enabled=1",
			)
			.all() as { a: string | null }[]
	).flatMap((row) => (row.a ? [row.a] : []));
}
/**
 * Every artifact revision that is published now: referenced by an enabled toolchain or the
 * pointer of a launcher artifact. Registration checks use it, so it does not look at adapters.
 */
export function publishedArtifacts(db: Database) {
	const seen = new Set<string>();
	const out: FixedDocument<ArtifactDefinitionV1>[] = [];
	for (const id of [...toolchainArtifactIds(db), ...artifactPointers(db)]) {
		if (seen.has(id)) continue;
		seen.add(id);
		const found = artifactInTransaction(db, id);
		if (found) out.push(found);
	}
	return out;
}

export function createArtifacts(deps: {
	activeToolchains: (db: Database) => FixedDefinition[];
	bindingOf: (
		db: Database,
		toolchainRevisionId: string,
	) => {
		binding: FixedDocument<CommandBindingV1>;
		artifact: FixedDocument<ArtifactDefinitionV1>;
	} | null;
	now: () => number;
}) {
	const entry = (
		artifact: FixedDocument<ArtifactDefinitionV1>,
		toolchain: FixedDefinition | null,
		bindingAdapter?: string,
	): ArtifactEntry => {
		const adapterRefs = unique([
			...(bindingAdapter ? [bindingAdapter] : []),
			...artifact.document.sourceBindings.map((s) => s.adapterRef),
		]);
		return {
			artifactId: artifact.document.id,
			artifactRevisionId: artifact.revisionId,
			title: artifact.document.title,
			toolchainId: toolchain?.id ?? null,
			toolchainRevisionId: toolchain?.revisionId ?? null,
			adapterRef: bindingAdapter ?? null,
			adapterRefs,
			...(artifact.document.launcher
				? { launcher: artifact.document.launcher }
				: {}),
		};
	};
	/**
	 * The artifacts of the active bound toolchains plus the published launcher artifacts, one
	 * entry per artifact revision (a toolchain's entry wins when both name the same revision).
	 */
	function artifactsInTransaction(db: Database): ArtifactEntry[] {
		const out: ArtifactEntry[] = [];
		const seen = new Set<string>();
		for (const d of deps.activeToolchains(db)) {
			const found = deps.bindingOf(db, d.revisionId);
			if (!found) continue;
			seen.add(found.artifact.revisionId);
			out.push(entry(found.artifact, d, found.binding.document.adapterRef));
		}
		for (const id of artifactPointers(db)) {
			const artifact = seen.has(id) ? null : artifactInTransaction(db, id);
			if (artifact) out.push(entry(artifact, null));
		}
		return out;
	}
	/** Publish a stored revision of a standalone artifact (also the way back to an earlier one). */
	function publishArtifactRevisionInTransaction(
		db: Database,
		artifactId: string,
		revisionId: string,
	) {
		const stored = getDocument(db, revisionId);
		if (
			stored?.kind !== "artifact" ||
			!revisionId.startsWith(`artifact:${artifactId}@`)
		)
			throw new Error("capability_not_found");
		const artifact = artifactInTransaction(db, revisionId);
		if (!artifact?.document.launcher) throw new Error("invalid_capability");
		setArtifactPointer(db, artifactId, revisionId, deps.now());
	}
	return { artifactsInTransaction, publishArtifactRevisionInTransaction };
}

/**
 * Registering an artifact revision with a `launcher` publishes it; one without a launcher takes
 * the artifact off the launcher list (it is then reachable only through a toolchain).
 */
export function publishRegisteredArtifact(
	db: Database,
	artifact: ArtifactDefinitionV1,
	revisionId: string,
	nowMs: number,
) {
	if (artifact.launcher) setArtifactPointer(db, artifact.id, revisionId, nowMs);
	else clearArtifactPointer(db, artifact.id);
}
