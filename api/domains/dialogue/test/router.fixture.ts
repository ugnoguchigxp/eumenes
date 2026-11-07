import type { RouteAnswer, RouteInput } from "../../inference/contracts";
import type { ToolchainCard } from "../../capabilities";
import { IMAGE, setup, type SetupOptions } from "./generation.fixture";
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
	profile: "router-fixture-profile" as string | undefined,
	entry: "route" as "route" | "routeStructured",
	structureResourceId: null as string | null,
	structureTimeoutMs: 8000,
	timeoutMs: 2000,
	accept: 0.6,
	low: 0.3,
	margin: 0.15,
	approve: 0.85,
	multi: 0.5,
	feedbackNear: 0.95,
	feedbackWeight: 2,
};
export type Script = (
	input: RouteInput,
	signal: AbortSignal,
) => Promise<RouteAnswer>;

/**
 * LARM's context judgment: these scores for the criteria named (0 for the rest; the conversation is never sent), and
 * probabilities in proportion. With the fixture's best-v2 a score of 0.95 is a sure top, 0.45 a top that is not sure,
 * and the conversation leads when nothing scores (generation.fixture `ROUTER_MODEL`).
 */
export const weigh =
	(scores: Record<string, number>): Script =>
	async (input) => {
		const names = input.criteria.map((c) => c.name);
		const given = Object.fromEntries(
			names.map((name) => [name, scores[name] ?? 0]),
		);
		const total = Object.values(given).reduce((a, b) => a + b, 0);
		const probabilities = Object.fromEntries(
			names.map((name) => [
				name,
				total ? given[name]! / total : 1 / names.length,
			]),
		);
		const best = names.reduce((a, b) => (given[b]! > given[a]! ? b : a));
		return {
			choice: best,
			probabilities,
			scores: given,
			model: "router-fixture-model",
			headRevision: "head-1",
			calibrationRevision: "cal-1",
		};
	};

/** One call of the structure model, as the router made it. */
export type StructureCall = {
	control: Record<string, unknown>;
	messages: Array<{ role: string; content: string }>;
	options: unknown;
	session: unknown;
};

/**
 * A harness with the router saved as `router` says, LARM's context judgment scripted (its calls are `routes`) and the
 * structure model scripted (`structures`: an answer, or an Error it fails with; its calls are `structureCalls`).
 */
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
	const routes: RouteInput[] = [];
	const scripts: Script[] = [];
	const structures: Array<string | Error> = [];
	const structureCalls: StructureCall[] = [];
	const controls = new Map<string, Record<string, unknown>>();
	Object.assign(h.larm, {
		route: async (input: RouteInput, signal: AbortSignal) => {
			routes.push(input);
			const next = scripts.shift();
			if (!next) throw new Error("fixture_route_missing");
			return next(input, signal);
		},
		captureBackgroundControlInTransaction: (
			_db: unknown,
			control: Record<string, unknown>,
		) => {
			const id = `structure-${controls.size + 1}`;
			controls.set(id, control);
			return id;
		},
		executeControl: async (
			requestId: string,
			messages: Array<{ role: string; content: string }>,
			_signal: AbortSignal,
			options: unknown,
			session: unknown,
		) => {
			structureCalls.push({
				control: controls.get(requestId)!,
				messages,
				options,
				session,
			});
			const next = structures.shift();
			if (next === undefined) throw new Error("fixture_structure_missing");
			if (next instanceof Error) throw next;
			let value = next;
			try {
				value = JSON.stringify({ decision: JSON.parse(next) });
			} catch {
				/* Deliberately malformed fixture. */
			}
			return { requestId, attemptId: "structure", value };
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
export const names = (input: RouteInput) => input.criteria.map((c) => c.name);
