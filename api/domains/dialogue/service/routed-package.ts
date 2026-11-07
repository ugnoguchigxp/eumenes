import {
	route,
	routeStructured,
	type RouteCandidate as PackageCandidate,
	type RouteDecision as PackageDecision,
	type RoutePorts,
	type Analyze,
	type RouteResult,
	type RouteTurn,
	type StructuredResult,
	type VectorSpace as PackageSpace,
} from "eumenes_router";
import { getLogger } from "../../../infrastructure/logger";
import type { InferencePort } from "../../inference";
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

/**
 * The eumenes_router package on the host's ports (spec router-package-integration 2026-11-04 §1): the router the turn
 * may ask, the package's ports (LARM's embedding and context judgment, the package's tables, best-v2, the structure
 * model), and the package's decision made the host's: the host's own offer of what it ranked, and its candidates by id.
 */
const log = getLogger("dialogue");
/** The structure model's answer is one small JSON object (the package's prompt asks for nothing else). */
const STRUCTURE_OUTPUT_TOKENS = 1024;

/**
 * The saved router, with the port that asks LARM's context judgment (spec router-package-integration 2026-11-04 §1).
 */
export type ActiveRouter = {
	settings: RouterSettings;
	route: NonNullable<InferencePort["route"]>;
};

/** What the package's ports are made of: the host's store and routing port, and the signal of the caller. */
export type RouterEnv = {
	store: DialogueDeps["store"];
	port: NonNullable<DialogueDeps["toolchains"]>;
	signal: AbortSignal;
};

/** The router the host may ask: none until a profile is saved, none when a port it needs is missing. */
export function activeRouter(
	deps: Pick<DialogueDeps, "larm" | "toolchains" | "store">,
): ActiveRouter | null {
	const snapshot = deps.larm.snapshotInTransaction?.bind(deps.larm);
	const route = deps.larm.route?.bind(deps.larm);
	const port = deps.toolchains;
	if (
		!snapshot ||
		!route ||
		!port?.embedRouter ||
		!port.routerCardsInTransaction ||
		!port.routerLexicalInTransaction ||
		!port.routerModelInTransaction
	)
		return null;
	const settings = deps.store.read((tx) => snapshot(tx)).router;
	if (!settings?.profile) return null;
	return { settings, route };
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

/**
 * The package's ports on the host's (spec router-package-integration 2026-11-04 §1 #4–#6): LARM's embedding (as
 * passages) and context judgment, each LARM call bounded by `timeoutMs`; the package's tables read on the host's
 * connection, one short read between the awaits; best-v2 with the memory of the embedding's space. `embedded` keeps
 * every text's vector (the trace and a later correction are found by it).
 */
export function portsOf(
	env: RouterEnv,
	router: ActiveRouter,
	model: RoutePorts["model"],
	embedded: Map<string, QueryVector>,
): RoutePorts {
	const { store, port, signal } = env;
	const { settings } = router;
	return {
		async embed(texts) {
			const missing = texts.filter((text) => !embedded.has(text));
			if (missing.length) {
				const r = await port.embedRouter!(missing, signal);
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
		async rerank(input) {
			const timeout = AbortSignal.timeout(settings.timeoutMs);
			try {
				return await router.route(input, AbortSignal.any([signal, timeout]));
			} catch (cause) {
				if (signal.aborted) throw cause;
				throw new Error(reasonOf(cause, timeout));
			}
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
		model,
		settings: {
			accept: settings.accept,
			low: settings.low,
			margin: settings.margin,
			approve: settings.approve,
			multi: settings.multi,
			feedbackNear: settings.feedbackNear,
			feedbackWeight: settings.feedbackWeight,
		},
		// The package's lines are ids and numbers; they go out under the log's own field names.
		log: ({ name, fields }) =>
			log.info("dialogue.router_package", {
				phase: name,
				...(typeof fields.row === "number" ? { row: fields.row } : {}),
				...(typeof fields.candidates === "number"
					? { candidateCount: fields.candidates }
					: {}),
				...(typeof fields.parts === "number" ? { count: fields.parts } : {}),
				...(typeof fields.requests === "number"
					? { hitCount: fields.requests }
					: {}),
				...(typeof fields.defer === "number"
					? { outcome: fields.defer ? "defer" : "sure" }
					: {}),
			}),
	};
}

/**
 * The structure model (`routeStructured`; spec router-package-integration 2026-11-04 §1 #8): the package's prompt as
 * it was measured, sent once to the saved structure resource (else the conversation route) as a background control
 * request with low reasoning effort. A failed or slow model returns no valid structure; the structured path stops
 * before work starts, and never falls back to routing a partial request.
 */
async function analyzeOf(
	turn: Turn,
	router: ActiveRouter,
	prompt: Parameters<Analyze>[0],
): Promise<string> {
	const { deps, input } = turn;
	const { larm } = deps;
	const { settings } = router;
	const timeout = AbortSignal.timeout(settings.structureTimeoutMs);
	try {
		if (!larm.captureBackgroundControlInTransaction || !larm.executeControl)
			throw new Error("structure_unavailable");
		const deadline = Date.parse(deps.clock()) + settings.structureTimeoutMs;
		const requestId = await deps.store.write((tx) =>
			larm.captureBackgroundControlInTransaction!(tx, {
				taskId: "router-structure",
				decisionId: input.runId,
				authorityEpoch: 1,
				executionGeneration: 1,
				deadline,
				taskDeadline: deadline,
				maxOutputTokens: STRUCTURE_OUTPUT_TOKENS,
				structuredOutput: true,
				route: settings.structureResourceId
					? { resourceId: settings.structureResourceId }
					: "conversation",
			}),
		);
		const receipt = await larm.executeControl(
			requestId,
			[
				{ role: "system", content: prompt.system },
				{ role: "user", content: prompt.user },
			],
			AbortSignal.any([turn.signal, timeout]),
			{
				instructions: "",
				outputSchema: prompt.outputSchema,
				reasoningEffort: "low",
			},
			{ sessionRole: "auxiliary" },
		);
		return typeof receipt.value === "string"
			? receipt.value
			: new TextDecoder().decode(receipt.value);
	} catch (cause) {
		if (turn.signal.aborted) throw cause;
		log.warn("dialogue.router_structure_failed", {
			reason: reasonOf(cause, timeout),
		});
		return "";
	}
}

/** The routing of one turn by the package's entry, as one shape: the parts it routed and the decision. */
export type Routed = {
	parts: ReadonlyArray<{ text: string; result: RouteResult }>;
	decision: PackageDecision;
	structure: StructuredResult["structure"] | null;
};

/** The package's evidence part; a multi-job pipeline keeps the full original request. */
export function decidedPart(routed: Routed) {
	return isPipelineDecision(routed.decision)
		? undefined
		: (routed.parts.find((p) => p.result.decision === routed.decision) ??
				routed.parts[0]);
}

/** Honor the router's multi-job decision through the registered planner, without a first-job fallback. */
export function hostDecision(
	decision: PackageDecision,
	hostOf: (c: PackageCandidate) => RouteCandidate | null,
	pipelineCandidate?: RouteCandidate,
): RouteDecision | null {
	// A planner can only execute registered tools. Do not lose a pending/control
	// decision, or an unavailable part, by replacing the full step set with a plan.
	if (
		decision.to === "pipeline" &&
		decision.steps.some(
			(step) =>
				step.decision.to !== "run" ||
				(step.candidate.kind !== "toolchain" &&
					step.candidate.kind !== "read") ||
				!hostOf(step.candidate),
		)
	)
		return null;
	// The pinned router exposes row 9 as `run/partial` in route(), and `pipeline` in routeStructured().
	if (isPipelineDecision(decision))
		return pipelineCandidate
			? { row: 9, to: "run", candidate: pipelineCandidate, announce: "fixed" }
			: null;
	switch (decision.to) {
		case "clarify":
			return decision;
		case "conversation":
			return decision;
		case "ask": {
			const first = hostOf(decision.options[0]);
			const second = hostOf(decision.options[1]);
			return first && second
				? { row: 8, to: "ask", options: [first, second] }
				: { row: 8, to: "conversation" };
		}
		case "run": {
			const candidate = hostOf(decision.candidate);
			return candidate ? { ...decision, candidate } : null;
		}
		case "again": {
			const candidate = hostOf(decision.candidate);
			return candidate ? { ...decision, candidate } : null;
		}
		case "pipeline":
			return pipelineCandidate
				? { row: 9, to: "run", candidate: pipelineCandidate, announce: "fixed" }
				: null;
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
	const pipelineIds = isPipelineDecision(routed.decision)
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
				p.result.corrected
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

/** The turn routed by the saved entry: the whole utterance (`route`), or the structure model first (`routeStructured`). */
export async function routeByEntry(
	turn: Turn,
	router: ActiveRouter,
	routeTurn: RouteTurn,
	model: RoutePorts["model"],
	embedded: Map<string, QueryVector>,
): Promise<Routed> {
	const ports = portsOf(
		{
			store: turn.deps.store,
			port: turn.deps.toolchains!,
			signal: turn.signal,
		},
		router,
		model,
		embedded,
	);
	if (router.settings.entry === "routeStructured") {
		const structured = await routeStructured(
			{ ...ports, analyze: (prompt) => analyzeOf(turn, router, prompt) },
			routeTurn,
		);
		return {
			parts: structured.parts,
			decision: structured.decision,
			structure: structured.structure,
		};
	}
	const whole = await route(ports, routeTurn);
	return {
		parts: [{ text: routeTurn.state.text, result: whole }],
		decision: whole.decision,
		structure: null,
	};
}

/** Translate both published multi-job variants of the pinned router contract. */
function isPipelineDecision(decision: PackageDecision) {
	return (
		decision.to === "pipeline" || (decision.to === "run" && decision.row === 9)
	);
}
