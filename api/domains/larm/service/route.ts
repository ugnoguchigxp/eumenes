import {
	ROUTE_LIMITS,
	routeCriterionName,
	routeErrors,
	type RouteAnswer,
	type RouteCriterion,
	type RouteInput,
} from "../contracts/route";
import type { LarmPort } from "../contracts";
import { readJson } from "./guards";
import type { Provider } from "./profiles";

const invalidRequest = () => new Error(routeErrors.invalidRequest);
const invalidResponse = () => new Error(routeErrors.invalidResponse);

/** Cuts at a code point boundary: a surrogate pair is never split. */
function head(text: string, limit: number) {
	if (text.length <= limit) return text;
	const code = text.charCodeAt(limit - 1);
	return text.slice(0, code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit);
}

/** The criteria of one choice as an object in the order given; a bad set is a caller bug and is never sent. */
function criteriaOf(criteria: readonly RouteCriterion[]) {
	if (criteria.length < 1 || criteria.length > ROUTE_LIMITS.criteria)
		throw invalidRequest();
	const seen = new Set<string>();
	for (const { name, description } of criteria) {
		if (
			typeof name !== "string" ||
			!routeCriterionName.test(name) ||
			seen.has(name) ||
			typeof description !== "string" ||
			!description.trim() ||
			description.length > ROUTE_LIMITS.description
		)
			throw invalidRequest();
		seen.add(name);
	}
	return Object.fromEntries(
		criteria.map(({ name, description }) => [name, description]),
	);
}

/**
 * The reranker's request: one `route` choice over the criteria, in the order given. The context judgment reads the
 * newest utterance only (its contract refuses history), cut at its bound; `instructions` are not its input.
 */
export function routeBody(input: RouteInput) {
	const state = { text: head(input.text, ROUTE_LIMITS.rerankText) };
	if (!state.text.trim()) throw invalidRequest();
	const route = {
		type: "choice",
		instructions: input.instructions,
		criteria: criteriaOf(input.criteria),
	};
	return (model: string) => ({ model, state, questions: { route } });
}

const object = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
const unit = (value: unknown): value is number =>
	typeof value === "number" &&
	Number.isFinite(value) &&
	value >= 0 &&
	value <= 1;

/** LARM may name the model by its long compatible name. */
function modelOf(answer: Record<string, unknown>, model: string) {
	return typeof answer.model === "string" && answer.model
		? answer.model.slice(0, 200)
		: model;
}
function revision(value: unknown) {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string") throw invalidResponse();
	return value ? value.slice(0, 200) : null;
}
/** LARM cut the state or dropped criteria: the answer is about something other than what was asked. */
function assertComplete(answer: Record<string, unknown>) {
	const dropped = answer.criteria_dropped;
	const some =
		Array.isArray(dropped) || typeof dropped === "string"
			? dropped.length > 0
			: dropped && typeof dropped === "object"
				? Object.keys(dropped).length > 0
				: typeof dropped === "number"
					? dropped > 0
					: Boolean(dropped);
	if (answer.truncated === true || some) throw new Error(routeErrors.truncated);
}
/** Exactly the names asked, each in [0,1], in the order asked. */
function unitsOf(value: unknown, names: readonly string[]) {
	const given = object(value);
	const keys = Object.keys(given);
	if (keys.length !== names.length) throw invalidResponse();
	return Object.fromEntries(
		names.map((name) => {
			const score = Object.hasOwn(given, name) ? given[name] : undefined;
			if (!unit(score)) throw invalidResponse();
			return [name, score];
		}),
	);
}

/** The reranker's answer, checked against the criteria sent; anything else is an invalid answer. */
export function readRouteAnswer(
	body: unknown,
	model: string,
	criteria: readonly RouteCriterion[],
): RouteAnswer {
	const answer = object(body);
	assertComplete(answer);
	const names = criteria.map((criterion) => criterion.name);
	const route = object(object(answer.answers).route);
	const choice = route.choice;
	if (typeof choice !== "string" || !names.includes(choice))
		throw invalidResponse();
	const probabilities = unitsOf(route.probabilities, names);
	const sum = Object.values(probabilities).reduce((a, b) => a + b, 0);
	if (Math.abs(sum - 1) > 0.01) throw invalidResponse();
	const routing = object(answer.routing);
	return {
		choice,
		probabilities,
		scores:
			route.scores === undefined || route.scores === null
				? null
				: unitsOf(route.scores, names),
		model: modelOf(answer, model),
		headRevision: revision(routing.head_revision),
		calibrationRevision: revision(routing.calibration_revision),
	};
}

const post = (body: unknown): RequestInit => ({
	method: "POST",
	headers: { "content-type": "application/json", accept: "application/json" },
	body: JSON.stringify(body),
});

/** The `route` of a port: only on a router port, which carries the decision provider alone. */
export function routePort(
	decisionOnly: boolean | undefined,
	lifetime: AbortSignal,
	withProvider: <T>(
		name: "system-one",
		signal: AbortSignal,
		use: (p: Provider, connectionId: string) => Promise<T>,
	) => Promise<T>,
	judgeInfer: (
		p: Provider,
		operation: string,
		init: RequestInit,
		signal: AbortSignal,
		connectionId: string,
	) => Promise<Response>,
): Pick<LarmPort, "route"> {
	return {
		async route(input, signal) {
			if (!decisionOnly) throw new Error(routeErrors.portRequired);
			// A request that breaks the limits is refused before a connection is borrowed.
			const body = routeBody(input);
			const scoped = AbortSignal.any([signal, lifetime]);
			return withProvider("system-one", scoped, async (p, connectionId) => {
				const response = await judgeInfer(
					p,
					"systemone",
					post(body(p.model)),
					scoped,
					connectionId,
				);
				const json = await readJson(response);
				scoped.throwIfAborted();
				return readRouteAnswer(json, p.model, input.criteria);
			});
		},
	};
}
