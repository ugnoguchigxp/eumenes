import type { Database } from "bun:sqlite";
import { kindOf, readToolEntries, toolchainPassages } from "./toolchains";
import {
	routerPassage,
	toolchainRuntimeOf,
	hash,
	type FixedDefinition,
} from "../contracts";
import { bindingInTransaction } from "./documents";
import { unpackVector } from "../../../infrastructure/vector";

/** Active revision of every registered toolchain, including disabled entries, plus the conversation's read tools. */
export function routingExportCards(db: Database, withEmbeddings: boolean) {
	const rows = db
		.query(
			"SELECT i.active_revision_id,i.enabled,i.generation,r.definition_json FROM capability_items i JOIN capability_revisions r ON r.id=i.active_revision_id WHERE i.kind='toolchain' ORDER BY i.id",
		)
		.all() as Array<{
		active_revision_id: string;
		enabled: number;
		generation: number;
		definition_json: string;
	}>;
	const definitions = rows.map((row) => ({
		d: {
			...JSON.parse(row.definition_json),
			revisionId: row.active_revision_id,
			generation: row.generation,
			hash: "",
		} as FixedDefinition,
		enabled: !!row.enabled,
		read: false,
	}));
	definitions.push(
		...readToolEntries.map((d) => ({ d, enabled: true, read: true })),
	);
	const cards = definitions.map(({ d, enabled, read }) => {
		const binding = d.bindingRevisionId
			? bindingInTransaction(db, d.bindingRevisionId)?.document
			: null;
		const operation = read
			? "read"
			: (binding?.execution ?? toolchainRuntimeOf(d.id)?.execution ?? null);
		const impact = read ? "none" : (d.minImpact ?? null);
		const high =
			impact === null
				? null
				: impact === "modify_existing" || impact === "irreversible";
		const passages = toolchainPassages(d);
		return {
			id: d.id,
			kind: read ? "read" : kindOf(db, d),
			name: d.title,
			description: d.summary,
			useWhen: d.useWhen,
			avoidWhen: read ? null : (d.avoidWhen ?? null),
			examples: d.examples ?? null,
			operation,
			minImpact: impact,
			highImpact: high,
			requiresApproval: high,
			enabled,
			version: d.revision,
			revisionId: d.revisionId,
			updatedAt: null,
			embeddingText: passages.join("\n"),
			embeddingPassages: passages,
			routerText: routerPassage(d),
		};
	});
	const embeddings = withEmbeddings
		? definitions.flatMap(({ d }) => {
				const passages = toolchainPassages(d);
				const vectors = db
					.query(
						"SELECT item,space,text_digest,vector FROM capability_toolchain_vectors WHERE revision_id=? ORDER BY space,item",
					)
					.all(d.revisionId) as Array<{
					item: number;
					space: string;
					text_digest: string;
					vector: Uint8Array;
				}>;
				return vectors
					.filter(
						(v) =>
							passages[v.item] !== undefined &&
							hash(passages[v.item]!) === v.text_digest,
					)
					.map((v) => ({
						cardId: d.id,
						revisionId: d.revisionId,
						item: v.item,
						spaceId: v.space,
						modelId: null as string | null,
						dimension: v.vector.byteLength / 4,
						vector: Array.from(unpackVector(v.vector)),
					}));
			})
		: [];
	return { cards, embeddings };
}
