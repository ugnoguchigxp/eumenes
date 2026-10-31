import type { ToolchainCard } from "../../capabilities";
import { getLogger } from "../../../infrastructure/logger";
import { isSystemPrompt } from "../contracts";
import type { ToolchainRoutingPort } from "../contracts/toolchains";
import { availableToolchainsInTransaction } from "./delegate-conversation";
import { availableReadTools } from "./executor-read";
import { TOOL_NAMES, toolRejection, type ParsedCall } from "./generation-tools";
import { sessionTargetsInTransaction } from "./specialist-context";

import {
	type ExecutorContext,
	type ToolOutcome,
	candidateOf,
} from "./executor-context";

const log = getLogger("dialogue");
/** What an instant toolchain's adapter may hand back as the answer. */
// An answer, or a read resource (at most 600 estimated tokens) with its JSON frame.
const INSTANT_MAX_CHARS = 2000;

/* The search for toolchains, the instant answers, and the trace of an answer (sections 6.1, 6.2, 6.5). */
export async function find(
	x: ExecutorContext,
	call: ParsedCall,
	query: string,
	signal: AbortSignal,
): Promise<ToolOutcome> {
	const { deps, offered, current, acted } = x;
	const { store, toolchains } = deps;
	if (!toolchains) return { result: { candidates: [] } };
	const vector = await toolchains.embedQuery(query, signal);
	signal.throwIfAborted();
	return store.write((tx) => {
		const run = current(tx);
		// A host-written prompt (a schedule, a notice) acts for no one present: it starts no work.
		if (isSystemPrompt(run.sourceKind))
			return { result: { candidates: [], code: "not_from_user" } };
		const route = toolchains.routeInTransaction(tx, {
			runId: run.id,
			text: query,
			...(vector ? { query: vector } : {}),
			// The read tools are found by the same search (spec conversation-read-tools-design 2026-10-31 §2.6).
			available: new Set([
				...availableToolchainsInTransaction(deps, tx, run),
				...availableReadTools(deps, tx),
			]),
			strict: true,
		});
		x.state.search = { route, ...(vector ? { query: vector } : {}) };
		for (const card of route.cards) offered.set(card.id, card);
		acted(tx, `find_toolchain:${call.call.id}`, {
			action: "find_toolchain",
			candidates: route.cards.map((card) => ({
				id: card.id,
				title: card.title,
			})),
		});
		log.info("dialogue.candidates_selected", {
			candidateCount: route.cards.length,
			retrieval: route.retrieval,
		});
		return {
			result: {
				candidates: route.cards.map((card) =>
					candidateOf(
						card,
						sessionTargetsInTransaction(deps, tx, card, run.id),
						(card.produces ?? []).flatMap(
							(kind) => deps.resources?.registry.kind(kind)?.label ?? [],
						),
					),
				),
				...(vector ? {} : { discovery: "embedding_unavailable" }),
			},
		};
	});
}

/** An instant toolchain answers inside the generation: no announcement and no TODO (section 6.5). */
export async function instant(
	x: ExecutorContext,
	call: ParsedCall,
	card: ToolchainCard,
	raw: Record<string, unknown> | undefined,
	signal: AbortSignal,
): Promise<ToolOutcome> {
	const { deps, current, acted } = x;
	const { store, toolchains } = deps;
	const parsed = card.instant!.parse(raw ?? {});
	if (!parsed.ok)
		throw toolRejection("invalid_tool_arguments", [
			{
				tool: TOOL_NAMES.delegate,
				path: "inputs",
				reason: "invalid_instant_inputs",
			},
		]);
	// Every authority is checked before the adapter runs, not only after.
	let conversationId = "";
	const prepared = store.read((db) => {
		conversationId = current(db).conversationId;
		toolchains!.resolveInTransaction(db, card.revisionId);
		return toolchains!.instantInTransaction?.(db, card.revisionId);
	});
	if (!prepared)
		return { result: { answered: false, code: "toolchain_unavailable" } };
	const started = Date.now();
	const answered = await prepared.run(parsed.value, signal, { conversationId });
	signal.throwIfAborted();
	const answer =
		answered.ok &&
		answered.answer.trim() &&
		answered.answer.length <= INSTANT_MAX_CHARS
			? answered.answer.trim()
			: null;
	log[answer ? "info" : "warn"]("dialogue.instant_answered", {
		toolchainId: card.id,
		durationMs: Date.now() - started,
		...(answer
			? {}
			: { reason: answered.ok ? "answer_invalid" : answered.code }),
	});
	await store.write((tx) => {
		current(tx);
		acted(tx, `delegate:${card.id}:instant`, {
			action: "delegate",
			toolchain: card.id,
			instant: true,
			answered: !!answer,
		});
	});
	if (answer) x.state.instant = { card, inputs: parsed.value };
	return answer
		? { result: { answered: true, answer } }
		: {
				result: {
					answered: false,
					...(prepared.fallback
						? { fallback: prepared.fallback.toolchainId }
						: {}),
				},
			};
}

/**
 * The trace of an utterance generation that answered without handing work over. `refused`: it asked a toolchain
 * and every such call was refused (its output broke the contract).
 */
export function answered(
	x: ExecutorContext,
	refused = false,
): Omit<
	Parameters<ToolchainRoutingPort["recordSelectionInTransaction"]>[1],
	"runId"
> {
	const { input } = x;
	// An instant toolchain's answer, or a read the search offered, is that one's decision with its inputs.
	const chosen = x.state.instant ?? x.state.read;
	return {
		conversationId: input.conversationId,
		retrieval: x.state.search?.route.retrieval ?? "none",
		candidates: (x.state.search?.route.cards ?? []).map((card) => ({
			toolchainId: card.id,
			revisionId: card.revisionId,
			functionName: card.functionName,
			...card.score,
		})),
		historyRefs:
			x.state.search?.route.past.map((past) => past.selectionId) ?? [],
		...(chosen
			? {
					decision: "toolchain" as const,
					toolchainId: chosen.card.id,
					toolchainRevisionId: chosen.card.revisionId,
					functionName: chosen.card.functionName,
					request: JSON.stringify(chosen.inputs),
				}
			: { decision: refused ? ("rejected" as const) : ("answer" as const) }),
		...(x.state.search?.query ? { query: x.state.search.query } : {}),
	};
}
