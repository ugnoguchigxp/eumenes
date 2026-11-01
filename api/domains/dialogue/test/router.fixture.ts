import type {
	RouteAnswer,
	RouteFieldsAnswer,
	RouteFieldsInput,
	RouteInput,
} from "../../inference/contracts";
import type { ToolchainCard } from "../../capabilities";
import { IMAGE, setup, type SetupOptions } from "./generation.fixture";
import { settings, type Snapshot } from "./harness.fixture";

/** The code LARM's router port throws when the deployed model cannot extract (larm contracts `routeErrors`). */
export const EXTRACT_UNSUPPORTED = "larm_route_extract_unsupported";

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
	mode: "on",
	profile: "router-fixture-profile",
	timeoutMs: 2000,
	accept: 0.6,
	low: 0.3,
	margin: 0.15,
	approve: 0.85,
	multi: 0.5,
	feedbackNear: 0.95,
	feedbackWeight: 2,
};
/** The router model of the test: each test has its own, as a refusal to extract is remembered per model. */
let model = "router-fixture-model";
let models = 0;
export type Script = (
	input: RouteInput,
	signal: AbortSignal,
) => Promise<RouteAnswer>;

/** The router's answer: these probabilities (the rest of the mass is shared by the others), and scores if given. */
export const weigh =
	(
		weights: Record<string, number>,
		scores?: Record<string, number>,
		as?: string,
	): Script =>
	async (input) => {
		const names = input.criteria.map((c) => c.name);
		const rest = names.filter((name) => !(name in weights));
		const left = Math.max(
			0,
			1 - names.reduce((sum, name) => sum + (weights[name] ?? 0), 0),
		);
		const probabilities = Object.fromEntries(
			names.map((name) => [
				name,
				name in weights ? weights[name]! : rest.length ? left / rest.length : 0,
			]),
		);
		const best = names.reduce((a, b) =>
			probabilities[b]! > probabilities[a]! ? b : a,
		);
		return {
			choice: best,
			probabilities,
			scores: scores ?? null,
			model: as ?? model,
			headRevision: "head-1",
			calibrationRevision: "cal-1",
		};
	};

export type Fields = (input: RouteFieldsInput) => Promise<RouteFieldsAnswer>;
export const fieldsAnswer =
	(
		values: RouteFieldsAnswer["values"],
		choices: RouteFieldsAnswer["choices"] = {},
	): Fields =>
	async () => ({
		choices,
		values,
		confidence: null,
		model: "router-fixture-model",
		headRevision: "head-1",
	});

/** A harness with the router saved as `router` says and scripted: its calls are `routes`, `fields`. */
export async function startRouter(
	router: Partial<typeof ROUTER> = {},
	options: SetupOptions = {},
) {
	model = `router-fixture-model-${++models}`;
	const h = await setup({
		settings: {
			...settings({ mode: "larm-only" }),
			router: { ...ROUTER, ...router },
		} as unknown as Snapshot,
		...options,
	});
	const routes: RouteInput[] = [];
	const fieldCalls: RouteFieldsInput[] = [];
	const scripts: Script[] = [];
	const fieldScripts: Fields[] = [];
	Object.assign(h.larm, {
		route: async (input: RouteInput, signal: AbortSignal) => {
			routes.push(input);
			const next = scripts.shift();
			if (!next) throw new Error("fixture_route_missing");
			return next(input, signal);
		},
		routeFields: async (input: RouteFieldsInput) => {
			fieldCalls.push(input);
			const next = fieldScripts.shift();
			if (!next) throw new Error("fixture_fields_missing");
			return next(input);
		},
	});
	return { h, routes, fieldCalls, scripts, fieldScripts };
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
		decided: string | null;
		workId: string | null;
		set: string[];
		row: number;
		error: string | null;
	};
export const names = (input: RouteInput) => input.criteria.map((c) => c.name);
