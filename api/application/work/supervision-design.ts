import type { Database } from "bun:sqlite";
import {
	createDesignGenerator,
	type DesignInference,
	type DesignInput,
} from "eumenes-agency/agenda/runtime";
import type {
	SupervisionDesignBinding,
	SupervisionDesignPreparation,
	SupervisionEvidence,
	SupervisionHost,
} from "../../domains/development-supervision/contracts";
import type { GeneratedInput, MarkdownService } from "../../domains/markdown";
import { formatResourceUri } from "../../domains/resources";
import { canonicalJson, sha256Hex } from "../../infrastructure/digest";

const owner = "development-supervision";
const frozen = (value: unknown) =>
	canonicalJson(value, { omitUndefined: true, keyOrder: "codeUnit" });
const citation = ({ kind, id }: SupervisionEvidence) =>
	`${kind === "memory" ? "memory" : "note"}:${id}`;

function snapshotEvidence(
	input: DesignInput,
	evidence: readonly SupervisionEvidence[],
) {
	const refs = new Set([
		...input.notes.map(({ id }) => `note:${id}`),
		...input.memory.map(({ id }) => `memory:${id}`),
	]);
	const references = new Map(input.notes.map((note) => [note.id, note.refs]));
	if (
		refs.size !== input.notes.length + input.memory.length ||
		evidence.some(
			(source) =>
				!source.ref || !source.digest || !refs.delete(citation(source)),
		) ||
		evidence.some(
			(source) =>
				source.kind !== "memory" &&
				!references.get(source.id)?.includes(source.ref),
		) ||
		refs.size
	)
		throw new Error("supervision_design_evidence_mismatch");
	return structuredClone(evidence);
}

export function createSupervisionDesigns(deps: {
	markdown: Pick<MarkdownService, "generated">;
	infer: DesignInference;
	/** Returns the current authorised parent and revision only while all input evidence remains available. */
	bindingInTransaction(
		db: Database,
		documentId: string,
		parentId: string,
	): SupervisionDesignBinding | null;
}): SupervisionHost["design"] {
	const { generated } = deps.markdown;
	const generate = createDesignGenerator(deps.infer);
	const lookup = (db: Database, id: string, ref: string) =>
		ref.startsWith(`${owner}:`)
			? deps.bindingInTransaction(db, id, ref.slice(owner.length + 1))
			: null;
	const matches = (binding: SupervisionDesignBinding, input: GeneratedInput) =>
		binding.documentId === input.id &&
		"conversationId" in input &&
		binding.conversationId === input.conversationId &&
		binding.sourceRunId === input.sourceRunId &&
		binding.digest === sha256Hex(input.markdown);

	generated.configureOwner(owner, {
		validInTransaction(db, id, ref) {
			return !!lookup(db, id, ref);
		},
		storedPreviewInTransaction(db, input) {
			const binding = lookup(db, input.id, input.ownerRef);
			return !!binding && matches(binding, input);
		},
	});
	const authorized = (db: Database, binding: SupervisionDesignBinding) => {
		const stored = deps.bindingInTransaction(
			db,
			binding.documentId,
			binding.parentId,
		);
		return !!stored && frozen(stored) === frozen(binding);
	};

	return {
		async prepare(
			input,
			evidence,
			signal,
		): Promise<SupervisionDesignPreparation> {
			const snapshot = structuredClone(input);
			const sources = snapshotEvidence(snapshot, evidence);
			const result = await generate(snapshot, signal);
			if (!result.markdown) return { kind: "blocked", reason: result.missing! };
			return {
				kind: "ready",
				title: result.title,
				markdown: result.markdown,
				digest: sha256Hex(result.markdown),
				evidence: sources,
			};
		},
		startInTransaction(db, binding, prepared) {
			if (binding.goal) throw new Error("supervision_goal_design_managed");
			if (
				!authorized(db, binding) ||
				prepared.digest !== binding.digest ||
				frozen(prepared.evidence) !== frozen(binding.evidence)
			)
				throw new Error("supervision_design_binding_mismatch");
			generated.startInTransaction(db, {
				id: binding.documentId,
				ownerRef: `${owner}:${binding.parentId}`,
				sourceRunId: binding.sourceRunId,
				conversationId: binding.conversationId,
				title: prepared.title,
				markdown: prepared.markdown,
				namespace: "eumenes",
				path: `designs/${binding.documentId}.md`,
				retention: "local",
			} satisfies GeneratedInput);
		},
		stateInTransaction(db, binding) {
			if (!authorized(db, binding)) return "unavailable";
			const receipt = generated.currentInTransaction(db, binding.documentId);
			if (receipt?.state === "pending") return "pending";
			return generated.localPreviewInTransaction(db, binding.documentId)
				? "ready"
				: "unavailable";
		},
		readInTransaction(db, binding) {
			if (!authorized(db, binding)) return null;
			const preview = generated.localPreviewInTransaction(
				db,
				binding.documentId,
			);
			if (!preview || sha256Hex(preview.markdown) !== binding.digest)
				return null;
			return {
				...preview,
				documentId: binding.documentId,
				digest: binding.digest,
				uri: formatResourceUri(
					"markdown.document",
					`generated-${binding.documentId}`,
				),
			};
		},
		cancelInTransaction: generated.cancelInTransaction,
	};
}
