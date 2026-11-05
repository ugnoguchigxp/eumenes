import type { Database } from "bun:sqlite";
import {
	dot,
	READ_TOOLS,
	toolchainPassages,
	type FixedDefinition,
	type PipelineDefinition,
	type VectorSpace,
} from "../../domains/capabilities";
import type { Capabilities } from "../../domains/capabilities";
import { CONVERSATION_ID, rerankDocument } from "eumenes_router";
import { routeTrial, type ToolchainRoutingPort } from "../../domains/dialogue";
import type { InferencePort } from "../../domains/inference";
import {
	checkText,
	documentInTransaction,
	runFixture,
} from "../../domains/pipelines";
import type { SqliteStore } from "../../infrastructure/sqlite";
import {
	pipelineBundle,
	pipelineFunctionName,
	pipelineToolchainId,
} from "./pipeline-bundle";
import type { PipelinesService } from "./pipelines-service";

/**
 * The studio's trials of a work's current draft (spec task-pipeline-design 2026-10-22 §8.2): where it ranks for a
 * wording (the same similarity as the candidate index, without registering it), what the first round chooses for
 * an utterance (nothing run), and a fixture case run without toolchains. The draft is read from the work.
 */
export function createPipelineTrials(deps: {
	store: SqliteStore;
	capabilities: Capabilities;
	routing: ToolchainRoutingPort;
	inference: InferencePort;
	service: PipelinesService;
	/** The conversation agent's part of the system message (the trial asks the same agent). */
	embedPassages?: (
		texts: string[],
	) => Promise<{ vectors: number[][]; space: VectorSpace } | undefined>;
}) {
	const { store, capabilities, routing, service } = deps;
	/** The work's draft checked whole; its findings when it would not publish. */
	function draftOf(db: Database, workRef: string) {
		const document = documentInTransaction(db, workRef);
		if (!document) throw new Error("work_not_found");
		const format = checkText(document.text);
		if (!format.ok)
			return {
				ok: false as const,
				issues: format.issues.map((i) => ({ pointer: i.path, rule: i.rule })),
			};
		const full = service.checkInTransaction(db, format.value);
		return full.ok ? { ok: true as const, definition: full.definition } : full;
	}
	/** The draft as the candidate index would see it: its toolchain definition and passages. */
	function draftToolchain(d: PipelineDefinition) {
		const definition = pipelineBundle(d, 1).definitions.find(
			(x) => x.kind === "toolchain",
		)! as unknown as FixedDefinition;
		return { definition, passages: toolchainPassages(definition) };
	}
	/** The draft and the active toolchains ranked by their closest passage to the wording, the draft in place. */
	async function rank(workRef: string, query: string, signal: AbortSignal) {
		const draft = store.read((db) => draftOf(db, workRef));
		if (!draft.ok) return draft;
		const { passages } = draftToolchain(draft.definition);
		const [vector, embedded] = await Promise.all([
			routing.embedQuery(query, signal),
			deps.embedPassages?.(passages),
		]);
		if (!vector || !embedded || embedded.space.modelId !== vector.space.modelId)
			return { ok: false as const, code: "embedding_unavailable" };
		const scores = embedded.vectors.map((v) => dot(v, vector.vector));
		const similarity = Math.max(...scores);
		const id = pipelineToolchainId(draft.definition);
		const others = store.read((db) => {
			const available = new Set(
				routing
					.catalogInTransaction(db)
					.filter((e) => e.id !== id)
					.map((e) => e.id),
			);
			return capabilities.toolchainCandidatesInTransaction(db, {
				text: query,
				vector: { space: vector.space, values: vector.vector },
				available: (toolchainId) => available.has(toolchainId),
				limit: 8,
				strict: true,
			});
		});
		const rows = [
			...others.map((c) => ({
				card: c,
				similarity: c.score.similarity,
				draft: false,
			})),
			{ card: null, similarity, draft: true },
		].sort((a, b) => (b.similarity ?? -Infinity) - (a.similarity ?? -Infinity));
		return {
			ok: true as const,
			definition: draft.definition,
			rows,
			passages: passages.map((text, i) => ({ text, similarity: scores[i]! })),
		};
	}
	return {
		async probe(workRef: string, query: string, signal: AbortSignal) {
			const ranked = await rank(workRef, query, signal);
			if (!ranked.ok) return ranked;
			const d = ranked.definition;
			return {
				ok: true as const,
				candidates: ranked.rows.map((r, i) => ({
					toolchainId: r.card?.id ?? pipelineToolchainId(d),
					title: r.card?.title ?? d.title,
					functionName: r.card?.functionName ?? pipelineFunctionName(d),
					rank: i + 1,
					similarity: r.similarity,
					ftsRank: r.card?.score.ftsRank ?? null,
					draft: r.draft,
				})),
				passages: ranked.passages,
			};
		},
		/**
		 * What the router decides for the utterance with the draft among the candidates (spec router-package-integration
		 * 2026-11-04): the package's decision on the whole utterance, nothing run. `chosen` names the function decided
		 * (`none` for the conversation, null when the router could not decide).
		 */
		async select(workRef: string, utterance: string, signal: AbortSignal) {
			const draft = store.read((db) => draftOf(db, workRef));
			if (!draft.ok) return draft;
			const d = draft.definition;
			const { definition } = draftToolchain(d);
			const id = pipelineToolchainId(d);
			const catalog = store.read((db) =>
				capabilities.toolchainsInTransaction(db),
			);
			const available = new Set([
				...store.read((db) =>
					routing
						.catalogInTransaction(db)
						.filter((e) => e.id !== id)
						.map((e) => e.id),
				),
				...READ_TOOLS.map((tool) => tool.name),
			]);
			const decided = await routeTrial(
				{ larm: deps.inference, toolchains: routing, store },
				{
					text: utterance,
					extra: [
						{
							id,
							kind: "toolchain",
							passage: rerankDocument({
								title: definition.title,
								summary: definition.summary,
								useWhen: definition.useWhen,
								examples: definition.examples ?? [],
							}),
							card: {
								id,
								title: definition.title,
								execution: "pipeline",
								score: {
									rank: 1,
									ftsRank: null,
									similarity: null,
									fromHistory: false,
								},
							},
							choice: { id, title: definition.title },
						},
					],
					available: (toolchainId) => available.has(toolchainId),
					signal,
				},
			);
			if ("code" in decided)
				return {
					ok: true as const,
					chosen: null,
					matched: false,
					next: null,
					inputs: null,
					code: decided.code,
				};
			const chosen =
				decided.decided === null
					? null
					: decided.decided === id
						? pipelineFunctionName(d)
						: decided.decided === CONVERSATION_ID
							? "none"
							: (catalog.find((c) => c.id === decided.decided)?.functionName ??
								decided.decided);
			return {
				ok: true as const,
				chosen,
				matched: decided.decided === id,
				next: null,
				inputs: null,
				code: null,
			};
		},
		fixture(workRef: string, test: number) {
			const draft = store.read((db) => draftOf(db, workRef));
			if (!draft.ok) return draft;
			if (!draft.definition.tests?.[test])
				return {
					ok: false as const,
					issues: [{ pointer: `/tests/${test}`, rule: "unknown_test" }],
				};
			return { ok: true as const, outcome: runFixture(draft.definition, test) };
		},
	};
}
export type PipelineTrials = ReturnType<typeof createPipelineTrials>;
