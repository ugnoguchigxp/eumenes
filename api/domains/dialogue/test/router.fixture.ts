import { TURN_STRUCTURE_PROMPT } from "eumenes_router";
import type { ToolchainCard } from "../../capabilities";
import {
	IMAGE,
	INSTANT,
	fixtureSelection,
	setup,
	type ChoiceInput,
	type SetupOptions,
} from "./generation.fixture";
import { settings, type Snapshot } from "./harness.fixture";

/** A second toolchain that changes what exists, so its hand-over is confirmed first. */
export const EDIT: ToolchainCard = {
	...IMAGE,
	id: "fake.edit",
	revisionId: "toolchain:fake.edit@1",
	functionName: "fake_edit",
	title: "編集",
	minImpact: "modify_existing",
};

export const ROUTER = {
	structureResourceId: null as string | null,
	structureTimeoutMs: 8000,
	feedbackNear: 0.95,
	feedbackWeight: 2,
};
export type Script = (
	input: ChoiceInput,
	signal: AbortSignal,
) => Promise<string[]>;

/** Ordered fixture preferences for the otherwise scripted decision API. */
export const weigh =
	(scores: Record<string, number>): Script =>
	async ({ criteria }) =>
		criteria
			.map(({ name }) => ({ name, priority: scores[name] ?? 0 }))
			.filter(({ priority }) => priority > 0)
			.sort((a, b) => b.priority - a.priority)
			.map(({ name }) => name);

/** One call of the structure model, as the router made it. */
export type StructureCall = {
	control: Record<string, unknown>;
	messages: Array<{ role: string; content: string }>;
	options: unknown;
	session: unknown;
	signal: AbortSignal;
};

/** Fixture with independently scripted structure and candidate selection. */
export async function startRouter(
	router: Partial<typeof ROUTER> = {},
	options: SetupOptions = {},
) {
	const h = await setup({
		settings: {
			...settings({ mode: "larm-only" }),
			router: { ...ROUTER, ...router },
		} as unknown as Snapshot,
		...options,
	});
	const routes: ChoiceInput[] = [];
	const scripts: Script[] = [];
	const structures: Array<string | Error | (() => Promise<string>)> = [];
	const structureCalls: StructureCall[] = [];
	let explicit = false;
	const select = fixtureSelection(
		async (
			{ text, criteria, previousUser, previousAgent, instructions },
			signal,
		) => {
			const next = scripts.shift();
			if (!next) return [];
			const received: ChoiceInput = {
				text,
				criteria,
				previousAgent,
				previousUser,
				instructions,
			};
			routes.push(received);
			const adapterInput = {
				...received,
				criteria: [
					...criteria,
					...(options.cards ?? [IMAGE, INSTANT])
						.filter(({ id }) => !criteria.some(({ name }) => name === id))
						.map(({ id, summary }) => ({ name: id, description: summary })),
					...(!criteria.some(({ name }) => name === "memory.request")
						? [{ name: "memory.request", description: "" }]
						: []),
				],
			};
			return next(adapterInput, signal);
		},
	);
	Object.assign(h.larm, {
		selectRouter: async (
			prompt: Parameters<typeof select>[0],
			signal: AbortSignal,
		) => {
			if (prompt.version !== TURN_STRUCTURE_PROMPT.version)
				return select(prompt, signal, explicit);
			explicit = structures.length > 0;
			if (!explicit) return select(prompt, signal);
			structureCalls.push({
				control: {},
				messages: [
					{ role: "system", content: prompt.system },
					{ role: "user", content: prompt.user },
				],
				options: { outputSchema: prompt.outputSchema },
				session: null,
				signal,
			});
			const next = structures.shift()!;
			if (next instanceof Error) throw next;
			const value = typeof next === "function" ? await next() : next;
			try {
				return JSON.stringify({ decision: JSON.parse(value) });
			} catch {
				return value;
			}
		},
	});
	return { h, routes, scripts, structures, structureCalls };
}

export const VECTOR = {
	space: { modelId: "m", revision: "1", artifactDigest: "d", dimension: 2 },
	vector: [1, 0],
};
/** The router's trace the store was asked to keep for the nth routed turn. */
export const traceOf = (h: { state: { traces: unknown[] } }, index = 0) =>
	h.state.traces[index] as {
		runId: string;
		text: string;
		query: unknown;
		decided: string | null;
		workId: string | null;
		set: string[];
		row: number;
		error: string | null;
	};
export const names = (input: ChoiceInput) => input.criteria.map((c) => c.name);
