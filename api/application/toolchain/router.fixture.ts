import type { Database } from "bun:sqlite";
import { TURN_STRUCTURE_PROMPT } from "eumenes_router";
import { fixtureDiscovery } from "./discovery.fixture";
import { createToolchainRouting } from "./toolchain-routing";
import type { HarnessOptions } from "./toolchain-harness-options.fixture";
import type { createToolchain } from "./toolchain";
import { READ_TOOLS, type Capabilities } from "../../domains/capabilities";
import {
	INPUT_HEADINGS,
	routerFixedCards,
	type ToolchainRoutingPort,
} from "../../domains/dialogue";
import { candidateLines } from "../../domains/dialogue/test/router-presentation.fixture";
import {
	fixtureSelection,
	ROUTER_SPACE,
	idsOfChoice,
} from "../../domains/dialogue/test/generation.fixture";
import type { InferencePort } from "../../domains/inference";
import type { SqliteStore } from "../../infrastructure/sqlite";

/** The model's answer to a choice-shaped request (`## Candidates` or `## Pending`, then the user's words). */
export type AskChoice = (
	messages: Array<{ role: "system" | "user"; content: string }>,
	round: "request" | "pending",
	signal: AbortSignal,
) => Promise<string>;

/**
 * The package structure call, told apart by its prompt version and the user payload.
 * A selection call carries `requests`; a structure call carries the utterance and does not.
 */
function isStructurePrompt(prompt: { version: string; user: string }): boolean {
	if (prompt.version !== TURN_STRUCTURE_PROMPT.version) return false;
	try {
		const data = JSON.parse(prompt.user) as {
			text?: unknown;
			requests?: unknown;
		};
		return typeof data.text === "string" && !Array.isArray(data.requests);
	} catch {
		return false;
	}
}

/** Adapt the application fixture's scripted answers to the router's structured selection calls. */
export async function attachFixtureRouter(input: {
	store: SqliteStore;
	inference: InferencePort;
	routing: ToolchainRoutingPort;
	capabilities: Capabilities;
	ask: AskChoice;
	/** The function the test's fixed embedding finds first for a text: the router's search finds it too. */
	discovery?: (text: string) => string;
	/** Scripted structure judgment. Selection then picks each request from its own candidates. */
	structure?: HarnessOptions["structure"];
}) {
	const selectRouter = fixtureSelection(async (route, signal) => {
		const names = route.criteria.map((c) => c.name);

		// The cards as the host's offer shows them (with their execution and inputs).
		const tools = input.store.read(
			(db) =>
				input.routing.routeInTransaction(db, {
					runId: "",
					text: route.text,
					available: new Set(
						input.capabilities
							.toolchainsInTransaction(db)
							.map(({ id }) => id)
							.concat(READ_TOOLS.map(({ name }) => name)),
					),
				}).cards,
		);
		const toolIds = new Set(tools.map((card) => card.id));
		const lines = [
			// One result per tool, as the fill call reads its candidate: a long list is not cut to the search's budget.
			...candidateLines(tools),
			...route.criteria
				.filter((c) => !toolIds.has(c.name))
				.map((c) => `- ${c.name}: ${c.description}`),
		];
		const pick = async (round: "request" | "pending") => {
			const heading =
				round === "request"
					? INPUT_HEADINGS.candidates
					: INPUT_HEADINGS.pending;
			const raw = await input.ask(
				[
					{ role: "system", content: "" },
					{
						role: "user",
						content: [
							heading,
							...lines,
							`${INPUT_HEADINGS.user}\n${route.text}`,
						].join("\n"),
					},
				],
				round,
				signal,
			);
			try {
				const parsed = JSON.parse(raw) as Record<string, unknown>;
				return typeof parsed.choice === "string"
					? (parsed as Record<string, unknown> & { choice: string })
					: { choice: "none" };
			} catch {
				return { choice: "none" };
			}
		};
		let picked = await pick("request");
		if (
			picked.choice === "none" &&
			names.some((n) => /^(c\d+\.approve|t\d+\.answer)$/.test(n))
		)
			picked = await pick("pending");
		return idsOfChoice(picked);
	});
	const structure = input.structure;
	Object.assign(input.inference, {
		// The scripted judgment never fills the selector's cache, so each later request is picked
		// from the candidates offered for that request.
		selectRouter: structure
			? async (
					prompt: Parameters<NonNullable<InferencePort["selectRouter"]>>[0],
					signal: AbortSignal,
				) => {
					if (!isStructurePrompt(prompt))
						return selectRouter(prompt, signal, true);
					return JSON.stringify({
						decision: structure([
							{ role: "system", content: prompt.system },
							{ role: "user", content: prompt.user },
						]),
					});
				}
			: selectRouter,
		routerSelectionAvailable: () => true,
	});
	Object.assign(input.routing, {
		embedRouter: async (texts: readonly string[]) => ({
			space: ROUTER_SPACE,
			vectors: texts.map(() => [1, 0]),
		}),
		routerCardsInTransaction: (
			db: Database,
			query: { available: (id: string) => boolean },
		) =>
			[
				...input.capabilities.routerCardsInTransaction(db),
				...routerFixedCards(),
			]
				.filter((card) => query.available(card.id))
				.map((card) => ({
					...card,
					useWhen: [...card.useWhen],
					examples: [...card.examples],
					passages: [new Float32Array([1, 0])],
				})),
		routerLexicalInTransaction: (db: Database, text: string) => {
			const scores = lexicalOf(
				[
					...input.capabilities.routerCardsInTransaction(db),
					...routerFixedCards(),
				],
				text,
			);
			const wanted = input.discovery?.(text);
			const found = wanted
				? [
						...input.capabilities
							.toolchainsInTransaction(db)
							.map((d) => [d.functionName, d.id] as const),
						...READ_TOOLS.map((tool) => [tool.name, tool.name] as const),
					].find(([name]) => name === wanted)?.[1]
				: undefined;
			if (found)
				scores.set(found, Math.max(0, ...scores.values()) + DISCOVERED);
			return scores;
		},
	});
}

/** What the discovered function's lexical score is above the best of the others. */
const DISCOVERED = 10;

/** The character trigrams of a text, as the package's lexical query takes them. */
function trigrams(text: string): Set<string> {
	const chars = [...text.normalize("NFKC").replace(/\s+/g, "")];
	const grams = new Set<string>();
	for (let i = 0; i + 3 <= chars.length; i++)
		grams.add(chars.slice(i, i + 3).join(""));
	return grams;
}

/**
 * The lexical scores the package's index would give (bm25 over each card's passages), approximated by the number of
 * the utterance's trigrams a card's best passage has: the fixture's vectors are all alike, so the words decide.
 */
function lexicalOf(
	cards: ReadonlyArray<{
		id: string;
		title: string;
		summary: string;
		useWhen: readonly string[];
		examples: readonly string[];
	}>,
	text: string,
): Map<string, number> {
	const grams = trigrams(text);
	const out = new Map<string, number>();
	for (const card of cards) {
		const best = Math.max(
			0,
			...[
				`${card.title}: ${card.summary}`,
				...card.useWhen,
				...card.examples,
			].map((passage) => {
				const own = trigrams(passage);
				return [...grams].filter((g) => own.has(g)).length;
			}),
		);
		if (best > 0) out.set(card.id, best);
	}
	return out;
}

/** A model's answer to the choice-shaped request, as its `answer` gives it for a call held to a schema. */
export const askModel =
	(model: Pick<import("../../domains/larm").LarmPort, "answer">): AskChoice =>
	(messages, _round, signal) =>
		model.answer(messages, signal, { jsonSchema: { type: "object" } } as never);

/** Bind the same capability catalog to the fixture's scripted or live decision provider. */
export async function fixtureRouting(input: {
	options: HarnessOptions;
	toolchain: Awaited<ReturnType<typeof createToolchain>>;
	store: SqliteStore;
	inference: InferencePort;
	ask: AskChoice;
}) {
	const { options, toolchain, store, inference, ask } = input;
	const discovery = (query: string) =>
		options.discoveryTarget?.(query) ??
		(options.history
			? "conversation_history"
			: (options.routeTool ??
				(options.uiCompositions
					? "ui_create"
					: options.weather && /天気/.test(query)
						? "weather_forecast"
						: options.stock && /株価/.test(query)
							? "stock_quote"
							: options.timers && /タイマー/.test(query)
								? "timer"
								: "service_search")));
	const routing = createToolchainRouting(
		toolchain.capabilities,
		toolchain.history,
		options.embed || options.liveRouting
			? toolchain.embedQuery
			: fixtureDiscovery(store, toolchain.capabilities, discovery),
		toolchain.registry,
		toolchain.schemas,
		undefined,
		options.liveRouting ? toolchain.embedRouter : undefined,
	);
	if (options.liveRouting) {
		if (options.embed) await toolchain.refreshVectors();
	} else {
		await attachFixtureRouter({
			store,
			inference,
			routing,
			capabilities: toolchain.capabilities,
			...(options.embed ? {} : { discovery }),
			ask: options.model ? askModel(options.model) : ask,
			...(options.structure ? { structure: options.structure } : {}),
		});
	}
	return routing;
}
