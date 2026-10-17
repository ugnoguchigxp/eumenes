import type { Database } from "bun:sqlite";
import { get } from "../repository";
import { zSchema } from "./schema";
import { createArtifacts } from "./artifacts";
import { indexSearch, validateToolchain } from "./registry";
import {
	artifactInTransaction,
	bindingInTransaction as storedBindingInTransaction,
} from "./documents";
import {
	dot,
	packVector,
	unpackVector,
	vectorSpaceKey,
} from "../../../infrastructure/vector";
import {
	hash,
	type FixedDefinition,
	type FixedDocument,
	type BindingV1,
	type ToolchainCard,
	type VectorSpace,
} from "../contracts";

export { dot, packVector, unpackVector, vectorSpaceKey };
/** The passages a toolchain is found by: its purpose, use cases and example requests. */
export function toolchainPassages(d: FixedDefinition) {
	return [`${d.title}: ${d.summary}`, ...d.useWhen, ...(d.examples ?? [])];
}

export function createToolchains(
	closure: (db: Database, revisionId: string) => FixedDefinition[],
	now: () => number,
) {
	function activeInTransaction(db: Database) {
		const rows = db
			.query(
				"SELECT active_revision_id FROM capability_items WHERE kind='toolchain' AND enabled=1 ORDER BY key",
			)
			.all() as { active_revision_id: string }[];
		return rows.flatMap((r) => {
			try {
				// The whole package (and its backend) must still be available.
				return [closure(db, r.active_revision_id)[0]!];
			} catch {
				return [];
			}
		});
	}
	function pendingVectorsInTransaction(db: Database, space: VectorSpace) {
		const key = vectorSpaceKey(space);
		return activeInTransaction(db).flatMap((d) =>
			toolchainPassages(d).flatMap((text, item) => {
				const row = db
					.query(
						"SELECT text_digest FROM capability_toolchain_vectors WHERE revision_id=? AND item=? AND space=?",
					)
					.get(d.revisionId, item, key) as { text_digest: string } | null;
				return row?.text_digest === hash(text)
					? []
					: [{ revisionId: d.revisionId, item, text }];
			}),
		);
	}
	function saveVectorsInTransaction(
		db: Database,
		space: VectorSpace,
		rows: Array<{
			revisionId: string;
			item: number;
			text: string;
			vector: number[];
		}>,
	) {
		const key = vectorSpaceKey(space);
		const active = new Map(
			activeInTransaction(db).map((d) => [d.revisionId, d] as const),
		);
		for (const row of rows) {
			const d = active.get(row.revisionId);
			// A changed or retired definition is simply not stored; the next refresh recomputes it.
			if (!d || toolchainPassages(d)[row.item] !== row.text) continue;
			if (row.vector.length !== space.dimension)
				throw new Error("invalid_embedding_result");
			db.query(
				"INSERT INTO capability_toolchain_vectors(revision_id,item,space,text_digest,vector) VALUES(?,?,?,?,?) ON CONFLICT(revision_id,item,space) DO UPDATE SET text_digest=excluded.text_digest,vector=excluded.vector",
			).run(
				row.revisionId,
				row.item,
				key,
				hash(row.text),
				packVector(row.vector),
			);
		}
	}
	/**
	 * Retrieve toolchains by similarity to the current request embedding.
	 * Past choices are reference data and never change this similarity. Retrieval only:
	 * the conversation model makes the choice.
	 */
	function candidatesInTransaction(
		db: Database,
		input: {
			text: string;
			vector?: { space: VectorSpace; values: number[] };
			available: (toolchainId: string) => boolean;
			fromHistory?: string[];
			limit?: number;
		},
	): ToolchainCard[] {
		const active = activeInTransaction(db).filter((d) => input.available(d.id));
		const byRevision = new Map(active.map((d) => [d.revisionId, d]));
		const similarity = new Map<string, number>();
		if (input.vector) {
			const key = vectorSpaceKey(input.vector.space);
			for (const row of db
				.query(
					"SELECT revision_id,vector FROM capability_toolchain_vectors WHERE space=?",
				)
				.all(key) as { revision_id: string; vector: Uint8Array }[]) {
				if (!byRevision.has(row.revision_id)) continue;
				const values = unpackVector(row.vector);
				if (values.length !== input.vector.values.length) continue;
				const score = dot(values, input.vector.values);
				if (score > (similarity.get(row.revision_id) ?? -Infinity))
					similarity.set(row.revision_id, score);
			}
		}
		const historical = new Set<string>();
		for (const id of input.fromHistory ?? []) {
			const d = active.find((x) => x.id === id);
			if (d) historical.add(d.revisionId);
		}
		// Preserve the existing all-capability fallback when embeddings are unavailable.
		const candidates = similarity.size
			? active
					.filter((d) => similarity.has(d.revisionId))
					.sort(
						(a, b) =>
							similarity.get(b.revisionId)! - similarity.get(a.revisionId)! ||
							a.id.localeCompare(b.id),
					)
					.slice(0, Math.min(8, Math.max(1, input.limit ?? 4)))
			: active;
		const functionOf = new Map(active.map((d) => [d.id, d.functionName!]));
		return candidates.map((d, i) => ({
			revisionId: d.revisionId,
			id: d.id,
			functionName: d.functionName!,
			title: d.title,
			summary: d.summary,
			useWhen: d.useWhen,
			redirects: (d.redirects ?? []).flatMap((r) =>
				functionOf.has(r.toolchainId)
					? [
							{
								when: r.when,
								toolchainId: r.toolchainId,
								functionName: functionOf.get(r.toolchainId)!,
							},
						]
					: [],
			),
			score: {
				rank: i + 1,
				ftsRank: null,
				similarity: similarity.has(d.revisionId)
					? Number(similarity.get(d.revisionId)!.toFixed(4))
					: null,
				fromHistory: historical.has(d.revisionId),
			},
		}));
	}
	/** The exact active toolchain revision and its package, or an error code. */
	function resolveInTransaction(db: Database, revisionId: string) {
		const d = activeInTransaction(db).find((x) => x.revisionId === revisionId);
		if (!d) throw new Error("toolchain_unavailable");
		return { toolchain: d, packageRevisionId: d.packageRevisionId! };
	}
	/**
	 * The fixed set a sub-agent loads: the package's profile (SystemContext), SKILL bodies and
	 * tool details (id, summary, input schema), resolved from the exact active revision.
	 */
	function setInTransaction(db: Database, revisionId: string) {
		const { toolchain, packageRevisionId } = resolveInTransaction(
			db,
			revisionId,
		);
		const all = closure(db, packageRevisionId);
		const pack = all[0]!;
		const byId = new Map(all.map((d) => [d.revisionId, d]));
		const profile = byId.get(pack.profileRevisionId ?? "")?.body?.trim();
		const skills = (pack.requiredSkillRevisionIds ?? []).map((id) =>
			byId.get(id)?.body?.trim(),
		);
		if (!profile || skills.some((b) => !b))
			throw new Error("required_context_missing");
		const binding = toolchain.bindingRevisionId
			? storedBindingInTransaction(db, toolchain.bindingRevisionId)
			: undefined;
		if (binding === null) throw new Error("required_context_missing");
		return {
			toolchain,
			package: pack,
			binding: binding as FixedDocument<BindingV1> | undefined,
			profile,
			skills: skills as string[],
			tools: (pack.toolRevisionIds ?? []).map((id) => {
				const tool = byId.get(id);
				if (!tool) throw new Error("required_context_missing");
				return {
					id: tool.id,
					revisionId: tool.revisionId,
					summary: tool.summary,
					schema: tool.schemaKey ? zSchema(tool.schemaKey) : null,
				};
			}),
		};
	}
	/** The (command or session) binding and artifact registration a bound toolchain revision names. */
	function bindingInTransaction(db: Database, toolchainRevisionId: string) {
		const d = get(db, toolchainRevisionId);
		if (d?.kind !== "toolchain" || !d.bindingRevisionId) return null;
		const binding = storedBindingInTransaction(db, d.bindingRevisionId);
		const artifact = d.artifactRevisionId
			? artifactInTransaction(db, d.artifactRevisionId)
			: null;
		return binding && artifact ? { binding, artifact } : null;
	}
	/**
	 * Make an existing revision of a toolchain the published one (also the way back to an
	 * earlier revision). Nothing is written unless the revision is complete and valid now.
	 */
	function publishRevisionInTransaction(
		db: Database,
		toolchainId: string,
		revisionId: string,
	) {
		const key = `toolchain:${toolchainId}`;
		const row = db
			.query("SELECT 1 FROM capability_revisions WHERE id=? AND item_key=?")
			.get(revisionId, key);
		if (!row) throw new Error("capability_not_found");
		const all = closure(db, revisionId);
		const d = get(db, revisionId)!;
		validateToolchain(db, d, all.slice(1));
		db.query(
			"UPDATE capability_items SET active_revision_id=?,generation=generation+1 WHERE key=?",
		).run(revisionId, key);
		indexSearch(db, d);
	}
	/** Every active toolchain's examples, for routing evaluation. */
	function examplesInTransaction(db: Database) {
		return activeInTransaction(db).map((d) => ({
			id: d.id,
			functionName: d.functionName!,
			examples: d.examples ?? [],
		}));
	}
	return {
		toolchainsInTransaction: activeInTransaction,
		pendingToolchainVectorsInTransaction: pendingVectorsInTransaction,
		saveToolchainVectorsInTransaction: saveVectorsInTransaction,
		toolchainCandidatesInTransaction: candidatesInTransaction,
		resolveToolchainInTransaction: resolveInTransaction,
		toolchainSetInTransaction: setInTransaction,
		toolchainBindingInTransaction: bindingInTransaction,
		...createArtifacts({
			activeToolchains: activeInTransaction,
			bindingOf: bindingInTransaction,
			now,
		}),
		publishToolchainRevisionInTransaction: publishRevisionInTransaction,
		toolchainExamplesInTransaction: examplesInTransaction,
	};
}
