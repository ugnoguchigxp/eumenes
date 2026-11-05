import type { Database } from "bun:sqlite";
import { READ_TOOLS, type Capabilities } from "../../domains/capabilities";
import {
	routerFixedCards,
	type ToolchainRoutingPort,
} from "../../domains/dialogue";
import { candidateOf } from "../../domains/dialogue/service/executor-context";
import { INPUT_HEADINGS } from "../../domains/dialogue/service/input-text";
import { toolResultText } from "../../domains/dialogue/service/result-text";
import {
	ROUTER_MODEL,
	ROUTER_SPACE,
	idsOfChoice,
} from "../../domains/dialogue/test/generation.fixture";
import type { InferencePort } from "../../domains/inference";
import type { RouteAnswer, RouteInput } from "../../domains/larm";
import type { createSettings } from "../../domains/settings";
import type { SqliteStore } from "../../infrastructure/sqlite";

/** The model's answer to a choice-shaped request (`## Candidates` or `## Pending`, then the user's words). */
export type AskChoice = (
	messages: Array<{ role: "system" | "user"; content: string }>,
	round: "request" | "pending",
	signal: AbortSignal,
) => Promise<string>;

/**
 * The router of an application fixture (spec router-package-integration 2026-11-04): the package's tables are fakes
 * (every enabled toolchain, read tool and the conversation's two, one vector each, best-v2 reading the context
 * judgment's score alone), its profile is saved, and LARM's context judgment is the test's conversation script asked
 * as the old choice call asked it: its toolchains and read tools read as the search's result lines, its pick is a sure
 * top (0.95), and a confirmation's yes or a question's answer is looked for when nothing else is picked.
 */
export async function attachFixtureRouter(input: {
	store: SqliteStore;
	inference: InferencePort;
	routing: ToolchainRoutingPort;
	settings: Awaited<ReturnType<typeof createSettings>>;
	capabilities: Capabilities;
	ask: AskChoice;
	/** The function the test's fixed embedding finds first for a text: the router's search finds it too. */
	discovery?: (text: string) => string;
}) {
	const route = async (
		route: RouteInput,
		signal: AbortSignal,
	): Promise<RouteAnswer> => {
		const names = route.criteria.map((c) => c.name);
		// The cards as the host's offer shows them (with their execution and inputs).
		const tools = input.store.read(
			(db) =>
				input.routing.routeInTransaction(db, {
					runId: "",
					text: route.text,
					available: new Set(names),
					ids: names,
				}).cards,
		);
		const toolIds = new Set(tools.map((card) => card.id));
		const lines = [
			// One result per tool, as the fill call reads its candidate: a long list is not cut to the search's budget.
			...tools.map((card) =>
				toolResultText("find_toolchain", {
					candidates: [candidateOf(card, null)],
				}),
			),
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
		const ids = idsOfChoice(picked);
		const scores = Object.fromEntries(
			names.map((name) => [name, ids.includes(name) ? 0.95 : 0]),
		);
		return {
			choice: names.find((name) => scores[name]) ?? names[0]!,
			probabilities: Object.fromEntries(
				names.map((name) => [name, 1 / names.length]),
			),
			scores,
			model: "router-fixture-model",
			headRevision: null,
			calibrationRevision: null,
		};
	};
	Object.assign(input.inference, { route });
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
		routerModelInTransaction: () => ROUTER_MODEL,
	});
	await input.settings.configureRouter({ profile: "router-fixture-profile" });
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
