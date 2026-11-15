import { HostAction, hostActionAnalyzer } from "./router-host-action";
import {
	routeWithSelection,
	type RouteCandidate as PackageCandidate,
	type RouteDecision as PackageDecision,
	type SelectionMode,
	type SelectionPorts,
	type SelectionResult,
	type SelectionTurn,
	type VectorSpace as PackageSpace,
} from "eumenes_router";
import { getLogger } from "../../../infrastructure/logger";
import { systemContext } from "../../../infrastructure/system-context";
import type { QueryVector } from "../contracts/toolchains";
import type { DialogueDeps } from "./context";
import { TOOL_NAMES } from "./generation-tools";
import type { ChoiceCandidate } from "./routed-choice";
import {
	type DynamicCandidate,
	type RouteCandidate,
	type RouteDecision,
	type RouterSettings,
} from "./routed-route";
import { retainedChoice } from "./routed-search";
import type { Turn } from "./routed-turn";

const log = getLogger("dialogue");
const LOOKUP_STRUCTURE = "dialogue.contexts.local.router-external-lookup";
const HANDOFF_STRUCTURE = systemContext(
	"dialogue.contexts.local.router-structure-handoff",
	{},
);

export type ActiveRouter = { settings: RouterSettings };
type RouterEnv = {
	store: DialogueDeps["store"];
	port: NonNullable<DialogueDeps["toolchains"]>;
	signal: AbortSignal;
};

export function activeRouter(
	deps: Pick<DialogueDeps, "larm" | "toolchains" | "store">,
): ActiveRouter | null {
	const port = deps.toolchains;
	if (
		!deps.larm.selectRouter ||
		!deps.larm.routerSelectionAvailable?.() ||
		!deps.larm.snapshotInTransaction ||
		!port?.embedRouter ||
		!port.routerCardsInTransaction ||
		!port.routerLexicalInTransaction
	)
		return null;
	return {
		settings: deps.store.read((tx) => deps.larm.snapshotInTransaction!(tx))
			.router,
	};
}

/** A failure as the log may name it: a code, never the words of a message. */
export function reasonOf(error: unknown, timeout?: AbortSignal): string {
	if (timeout?.aborted) return "timeout";
	return error instanceof Error && /^[a-z0-9_]{1,80}$/.test(error.message)
		? error.message
		: "router_failed";
}

/** A vector space as the package names it: the four fields its key is made of. */
const packageSpace = (space: QueryVector["space"]): PackageSpace => ({
	modelId: space.modelId,
	revision: space.revision,
	artifactDigest: space.artifactDigest,
	dimension: space.dimension,
});

function searchPorts(
	env: RouterEnv,
	router: ActiveRouter,
	embedded: Map<string, QueryVector>,
): Omit<SelectionPorts, "select"> {
	const { store, port, signal } = env;
	const { settings } = router;
	return {
		async embed(texts) {
			signal.throwIfAborted();
			const missing = texts.filter((text) => !embedded.has(text));
			if (missing.length) {
				const r = await port.embedRouter!(missing, signal);
				signal.throwIfAborted();
				missing.forEach((text, i) =>
					embedded.set(text, { space: r.space, vector: r.vectors[i]! }),
				);
			}
			const vectors = texts.map((text) => embedded.get(text)!);
			return {
				space: packageSpace(vectors[0]!.space),
				vectors: vectors.map((v) => v.vector),
			};
		},
		read: {
			cards: (query) =>
				store.read((tx) => port.routerCardsInTransaction!(tx, query)),
			lexical: (text) =>
				store.read((tx) => port.routerLexicalInTransaction!(tx, text)),
			nearFeedback: (query) =>
				port.nearRouterFeedbackInTransaction
					? store.read((tx) =>
							port.nearRouterFeedbackInTransaction!(tx, {
								space: query.space,
								vector: [...query.vector],
								threshold: query.threshold,
								...(query.limit ? { limit: query.limit } : {}),
							}),
						)
					: [],
		},
		settings: {
			feedbackNear: settings.feedbackNear,
			feedbackWeight: settings.feedbackWeight,
		},
	};
}

export type Routed = SelectionResult;

export function decidedPart(routed: Routed) {
	if (routed.decision.to === "pipeline") return;
	const id = routed.decision.to === "run" ? routed.decision.candidate.id : null;
	return (
		routed.parts.find(
			(part) => part.selection.kind === "candidate" && part.selection.id === id,
		) ?? routed.parts[0]
	);
}

/** Honor the router's multi-job decision through the registered planner, without a first-job fallback. */
export function hostDecision(
	decision: PackageDecision,
	hostOf: (c: PackageCandidate) => RouteCandidate | null,
	pipelineCandidate?: RouteCandidate,
): RouteDecision | null {
	switch (decision.to) {
		case "clarify":
		case "unresolved":
			return decision;
		case "conversation":
			return decision;
		case "run": {
			const candidate = hostOf(decision.candidate);
			return candidate ? { ...decision, candidate } : null;
		}
		case "pipeline": {
			if (pipelineCandidate?.kind !== "toolchain") return null;
			const steps = [];
			for (const { text, after, candidate, decision: part } of decision.steps) {
				const host = hostOf(candidate);
				if (
					part.to !== "run" ||
					(candidate.kind !== "toolchain" && candidate.kind !== "read") ||
					(host?.kind !== "toolchain" && host?.kind !== "read")
				)
					return null;
				steps.push({
					text,
					after,
					entry: host.id,
					revisionId: host.card.revisionId,
				});
			}
			return { row: 9, to: "pipeline", candidate: pipelineCandidate, steps };
		}
	}
}

/**
 * The host's own offer of what the package ranked (its search's tools in every part, and the toolchains a redirect
 * names), through the turn's `find_toolchain` operation: the authority, the availability and the record are the
 * host's. The package's candidates become the host's by id.
 */
export async function offer(
	turn: Turn,
	words: string,
	routed: Routed,
	dynamic: readonly DynamicCandidate[],
): Promise<{
	candidates: RouteCandidate[];
	hostOf: (c: PackageCandidate) => RouteCandidate | null;
}> {
	const pipelineIds =
		routed.decision.to === "pipeline"
			? turn.deps.store.read((db) =>
					turn.deps
						.toolchains!.catalogInTransaction(db)
						.filter(
							(e) =>
								e.runtime.execution === "pipeline" &&
								e.runtime.binding?.available,
						)
						.map((e) => e.id),
				)
			: [];
	const ids = [
		...new Set([
			...pipelineIds,
			...routed.parts.flatMap((p) =>
				p.candidates
					.map((r) => r.candidate)
					.filter((c) => c.kind === "toolchain" || c.kind === "read")
					.map((c) => c.id),
			),
			...dynamic.flatMap((c) => (c.kind === "redirect" ? [c.toolchainId] : [])),
		]),
	];
	const tools = new Map<
		string,
		Extract<RouteCandidate, { kind: "toolchain" | "read" }>
	>();
	if (ids.length) {
		const found = await turn.act(TOOL_NAMES.search, {
			query: words.trim().slice(0, 2000),
			ids,
		});
		const outcome = "outcome" in found ? found.outcome : null;
		const shown =
			(outcome?.result as { candidates?: ChoiceCandidate[] } | undefined)
				?.candidates ?? [];
		for (const card of outcome?.search?.cards ?? []) {
			const choice = shown.find((c) => c.id === card.id);
			if (choice)
				tools.set(card.id, {
					id: card.id,
					kind: card.read ? "read" : "toolchain",
					passage: card.summary,
					card,
					choice,
				});
		}
	}
	// A toolchain of the work in progress keeps what its session works on as its target.
	for (const entry of turn.input.retained)
		if (!tools.has(entry.card.id) && ids.includes(entry.card.id))
			tools.set(entry.card.id, {
				id: entry.card.id,
				kind: "toolchain",
				passage: entry.card.summary,
				card: entry.card,
				choice: retainedChoice(turn, entry.card),
			});
	const own = new Map<string, RouteCandidate>(dynamic.map((c) => [c.id, c]));
	const hostOf = (c: PackageCandidate): RouteCandidate | null => {
		switch (c.kind) {
			case "conversation":
				return { id: c.id, kind: "conversation", passage: c.passage };
			case "memory":
				return { id: c.id, kind: "memory", passage: c.passage };
			case "toolchain":
			case "read":
				return tools.get(c.id) ?? null;
			default:
				return own.get(c.id) ?? null;
		}
	};
	return { candidates: [...tools.values(), ...dynamic], hostOf };
}

export async function routeByEntry(
	turn: Turn,
	router: ActiveRouter,
	routeTurn: SelectionTurn,
	embedded: Map<string, QueryVector>,
	mode: SelectionMode = "conversation",
): Promise<Routed> {
	const timeout = AbortSignal.timeout(router.settings.structureTimeoutMs);
	const signal = AbortSignal.any([turn.signal, timeout]);
	const env = { store: turn.deps.store, port: turn.deps.toolchains!, signal };
	const call = turn.deps.larm.selectRouter!.bind(turn.deps.larm);
	const started = performance.now();
	try {
		const analyze = hostActionAnalyzer(
			(prompt) =>
				call(
					{
						...prompt,
						system: [
							prompt.system,
							HANDOFF_STRUCTURE,
							...(turn.deps.lookup
								? [systemContext(LOOKUP_STRUCTURE, {})]
								: []),
						].join("\n\n"),
					},
					signal,
				),
			routeTurn.dynamic ?? [],
			turn.utterance,
		);
		const result = await routeWithSelection(
			{
				...searchPorts(env, router, embedded),
				select: (prompt) => call(prompt, signal),
				analyze,
			},
			routeTurn,
			{ mode, signal },
		).catch((cause: unknown): Routed => {
			signal.throwIfAborted();
			if (!(cause instanceof HostAction)) throw cause;
			return { decision: cause.decision, structure: null, parts: [] };
		});
		log.info("dialogue.router_selection", {
			source: mode,
			kind: result.decision.to,
			candidateCount: Math.max(
				0,
				...result.parts.map((part) => part.candidates.length),
			),
			count: result.parts.reduce(
				(sum, part) => sum + part.candidates.length,
				0,
			),
			durationMs: Math.round(performance.now() - started),
		});
		return result;
	} catch (cause) {
		if (turn.signal.aborted) throw cause;
		const reason = reasonOf(cause, timeout);
		log.warn("dialogue.router_selection_failed", {
			source: mode,
			reason,
			durationMs: Math.round(performance.now() - started),
		});
		throw new Error(reason);
	}
}
