import type { Database } from "bun:sqlite";
import {
	dot,
	toolchainPassages,
	type FixedDefinition,
	type PipelineDefinition,
	type ToolchainCard,
	type VectorSpace,
} from "../../domains/capabilities";
import type { Capabilities } from "../../domains/capabilities";
import {
	trialFirstRound,
	type ConversationAgentSystem,
	type ToolchainRoutingPort,
} from "../../domains/dialogue";
import type { InferencePort } from "../../domains/inference";
import {
	checkText,
	documentInTransaction,
	inputParameters,
	parseInputs,
	runFixture,
	stepOutline,
} from "../../domains/pipelines";
import type { SqliteStore } from "../../infrastructure/sqlite";
import {
	pipelineBundle,
	pipelineFunctionName,
	pipelineToolchainId,
} from "./pipeline-bundle";
import type { PipelinesService } from "./pipelines-service";

/** As many candidates as a conversation's discovery offers its first round. */
const OFFERED = 4;

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
	agentSystem: () => ConversationAgentSystem;
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
	/** The draft as a candidate card of the first round, the way the routing fills a published pipeline's. */
	function draftCard(
		d: PipelineDefinition,
		rankOf: number,
		similarity: number,
	): ToolchainCard {
		const { definition } = draftToolchain(d);
		return {
			execution: "pipeline",
			revisionId: `toolchain:${pipelineToolchainId(d)}@draft`,
			id: pipelineToolchainId(d),
			functionName: pipelineFunctionName(d),
			title: definition.title,
			summary: definition.summary,
			useWhen: definition.useWhen,
			redirects: [],
			pipeline: {
				parameters: inputParameters(d),
				outline: stepOutline(d),
				parse: (args, request) => parseInputs(d, args, request),
			},
			score: { rank: rankOf, ftsRank: null, similarity, fromHistory: false },
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
		/** The first round over the candidates a conversation would offer for the utterance (the draft among them). */
		async select(workRef: string, utterance: string, signal: AbortSignal) {
			const ranked = await rank(workRef, utterance, signal);
			if (!ranked.ok) return ranked;
			const capture = deps.inference.captureUserControlInTransaction;
			if (!capture || !deps.inference.executeStream)
				return { ok: false as const, code: "inference_unavailable" };
			const offered = ranked.rows.slice(0, OFFERED);
			const requestId = await store.write((db) =>
				capture(db, {
					subject: `pipeline-trial:${workRef}`,
					deadline: Date.now() + 120_000,
					maxOutputTokens: 1024,
				}),
			);
			const cards = store.read((db) =>
				offered.flatMap((r, i) =>
					r.draft
						? [draftCard(ranked.definition, i + 1, r.similarity!)]
						: r.card
							? (() => {
									const card = routing.cardInTransaction(
										db,
										r.card!.revisionId,
									);
									return card ? [card] : [];
								})()
							: [],
				),
			);
			const round = await trialFirstRound(deps.inference, {
				requestId,
				text: utterance,
				cards,
				agentSystem: deps.agentSystem(),
				signal,
			});
			return {
				ok: true as const,
				chosen: round.chosen,
				matched: round.chosen === pipelineFunctionName(ranked.definition),
				next: round.next,
				inputs: round.inputs,
				code: round.code,
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
