import {
	head,
	route,
	routeStructured,
	type RouteCandidate as PackageCandidate,
	type RouteDecision as PackageDecision,
	type RoutePorts,
	type RouteResult,
	type RouteTurn,
	type StructuredResult,
	type VectorSpace as PackageSpace,
} from "eumenes_router";
import { getLogger } from "../../../infrastructure/logger";
import { systemContext } from "../../../infrastructure/system-context";
import type { InferencePort } from "../../inference";
import type { QueryVector } from "../contracts/toolchains";
import type { DialogueDeps } from "./context";
import { TOOL_NAMES } from "./generation-tools";
import type { ChoiceCandidate } from "./routed-choice";
import {
	CONVERSATION_ID,
	MEMORY_ID,
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
 * request with low reasoning effort. A model that fails or is slow gives no structure: the package then routes the
 * whole utterance, as `route` does.
 */
async function analyzeOf(
	turn: Turn,
	router: ActiveRouter,
	prompt: { version: string; system: string; user: string },
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
				outputSchema: { type: "object" },
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
	structure: StructuredResult["structure"];
};

/** The part the decision came from: the one decided, or the first step of a pipeline that is a tool. */
export function decidedPart(routed: Routed) {
	const { parts, decision } = routed;
	if (decision.to === "pipeline") {
		const step = firstStep(decision);
		return parts.find((p) => p.text === step?.text) ?? parts[0];
	}
	return parts.find((p) => p.result.decision === decision) ?? parts[0];
}

/**
 * The step of a pipeline the host does first: the first that is a toolchain or a read tool, in the structure's order;
 * else the first that is anything but the conversation (a memory request, the host's own work).
 */
function firstStep(decision: Extract<PackageDecision, { to: "pipeline" }>) {
	return (
		decision.steps.find(
			(s) => s.candidate.kind === "toolchain" || s.candidate.kind === "read",
		) ?? decision.steps.find((s) => s.candidate.kind !== "conversation")
	);
}

/**
 * The package's decision as the host carries it out. A pipeline's steps go to the pipeline stage, which is being
 * rebuilt apart (spec router-package-integration 2026-11-04 §1 #9): until then the first step that is a tool is done
 * and the user is told the rest was not asked for (row 9, as a request of several jobs). A candidate the host cannot
 * carry out (it left the offer) is no decision.
 */
export function hostDecision(
	decision: PackageDecision,
	hostOf: (c: PackageCandidate) => RouteCandidate | null,
): RouteDecision | null {
	switch (decision.to) {
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
		case "pipeline": {
			const step = firstStep(decision);
			const candidate = step ? hostOf(step.candidate) : null;
			return candidate
				? { row: 9, to: "run", candidate, announce: "partial" }
				: { row: 1, to: "conversation" };
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
	const ids = [
		...new Set([
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

/**
 * The router's decision on one utterance as a trial (the pipeline studio's selection trial, spec task-pipeline-design
 * 2026-10-22 §8.2): the whole utterance through the package (`route`), on an empty conversation, with the caller's
 * candidates beside its search (a draft that is not synced yet). Nothing is handed over and nothing is recorded. The
 * decided id: a toolchain or read tool, the conversation's, or null when the router asks or cannot decide.
 */
export async function routeTrial(
	deps: Pick<DialogueDeps, "larm" | "toolchains" | "store">,
	input: {
		text: string;
		extra: readonly PackageCandidate[];
		available: (id: string) => boolean;
		signal: AbortSignal;
	},
): Promise<{ decided: string | null } | { code: string }> {
	const router = activeRouter(deps);
	if (!router) return { code: "router_unavailable" };
	const env = {
		store: deps.store,
		port: deps.toolchains!,
		signal: input.signal,
	};
	const embedded = new Map<string, QueryVector>();
	try {
		const text = head(input.text.trim(), 2000);
		const r = await env.port.embedRouter!([text], input.signal);
		embedded.set(text, { space: r.space, vector: r.vectors[0]! });
		const model = deps.store.read((tx) =>
			env.port.routerModelInTransaction!(tx, r.space),
		);
		if (!model) return { code: "router_memory_missing" };
		const result = await route(portsOf(env, router, model, embedded), {
			state: {
				text: input.text.trim(),
				previousAgent: null,
				previousUser: null,
			},
			dynamic: input.extra,
			available: (id) =>
				id === CONVERSATION_ID || id === MEMORY_ID || input.available(id),
			instructions: systemContext(
				"dialogue.contexts.local.router-instructions",
				{},
			),
		});
		const { decision } = result;
		switch (decision.to) {
			case "conversation":
				return { decided: CONVERSATION_ID };
			case "ask":
				return { decided: null };
			case "pipeline":
				return { decided: firstStep(decision)?.candidate.id ?? null };
			default:
				return { decided: decision.candidate.id };
		}
	} catch (cause) {
		if (input.signal.aborted) throw cause;
		return { code: reasonOf(cause) };
	}
}
