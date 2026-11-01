import {
	ROUTE_LIMITS,
	routeCriterionName,
	routeErrors,
	routeQuestionName,
	type RouteAnswer,
	type RouteCriterion,
	type RouteFieldSchema,
	type RouteFieldsAnswer,
	type RouteFieldsInput,
	type RouteInput,
} from "../contracts/route";
import type { LarmPort } from "../contracts";
import { readJson } from "./guards";
import { LarmInferenceError } from "./inference-error";
import type { Provider } from "./profiles";

const invalidRequest = () => new Error(routeErrors.invalidRequest);
const invalidResponse = () => new Error(routeErrors.invalidResponse);

/** Cuts at a code point boundary: a surrogate pair is never split. */
function head(text: string, limit: number) {
	if (text.length <= limit) return text;
	const code = text.charCodeAt(limit - 1);
	return text.slice(0, code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit);
}
function tail(text: string, limit: number) {
	if (text.length <= limit) return text;
	const code = text.charCodeAt(text.length - limit);
	return text.slice(
		text.length - limit + (code >= 0xdc00 && code <= 0xdfff ? 1 : 0),
	);
}

/** The state of both calls: the newest utterance's head and the two before it, tails; empty ones are left out. */
function routeState(input: {
	text: string;
	previousAgent: string | null;
	previousUser: string | null;
}) {
	return {
		...(input.previousAgent
			? { previous_agent: tail(input.previousAgent, ROUTE_LIMITS.previous) }
			: {}),
		...(input.previousUser
			? { previous_user: tail(input.previousUser, ROUTE_LIMITS.previous) }
			: {}),
		text: head(input.text, ROUTE_LIMITS.text),
	};
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

/** The router's request: one `route` choice over the criteria, in the order given. */
export function routeBody(input: RouteInput) {
	const state = routeState(input);
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
/** One choice of the answer: one of the criteria asked. */
function choiceOf(answered: unknown, names: readonly string[]) {
	const choice = object(answered).choice;
	if (typeof choice !== "string" || !names.includes(choice))
		throw invalidResponse();
	return choice;
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

/** The router's answer, checked against the criteria sent; anything else is an invalid answer. */
export function readRouteAnswer(
	body: unknown,
	model: string,
	criteria: readonly RouteCriterion[],
): RouteAnswer {
	const answer = object(body);
	assertComplete(answer);
	const names = criteria.map((criterion) => criterion.name);
	const route = object(object(answer.answers).route);
	const choice = choiceOf(route, names);
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

/** One routing on the claimed decision provider of a router port, with that claim's model and credential. */
export async function requestRoute(
	p: Provider,
	input: RouteInput,
	body: ReturnType<typeof routeBody>,
	signal: AbortSignal,
	send: (init: RequestInit) => Promise<Response>,
): Promise<RouteAnswer> {
	const response = await send(post(body(p.model)));
	const json = await readJson(response);
	signal.throwIfAborted();
	return readRouteAnswer(json, p.model, input.criteria);
}

const post = (body: unknown): RequestInit => ({
	method: "POST",
	headers: { "content-type": "application/json", accept: "application/json" },
	body: JSON.stringify(body),
});

type Property = RouteFieldSchema["properties"][string];
const propertyTypes = new Set(["string", "number", "boolean"]);

/** The extraction's schema, rebuilt from the flat shape the contract allows; deeper or wider shapes are refused. */
function schemaOf(schema: RouteFieldSchema): RouteFieldSchema {
	const raw = object(schema);
	const properties = object(raw.properties);
	const names = Object.keys(properties);
	if (
		raw.type !== "object" ||
		!Array.isArray(raw.required) ||
		names.length < 1 ||
		Object.keys(raw).some(
			(key) => !["type", "required", "properties"].includes(key),
		) ||
		raw.required.some(
			(name) => typeof name !== "string" || !names.includes(name),
		)
	)
		throw invalidRequest();
	const built: RouteFieldSchema["properties"] = {};
	for (const name of names) {
		const property = object(properties[name]);
		const options = property.enum;
		if (
			!routeQuestionName.test(name) ||
			typeof property.type !== "string" ||
			!propertyTypes.has(property.type) ||
			Object.keys(property).some(
				(key) => !["type", "enum", "description"].includes(key),
			) ||
			(property.description !== undefined &&
				typeof property.description !== "string") ||
			(options !== undefined &&
				(property.type !== "string" ||
					!Array.isArray(options) ||
					options.length < 1 ||
					options.some((option) => typeof option !== "string" || !option)))
		)
			throw invalidRequest();
		built[name] = {
			type: property.type as Property["type"],
			...(options ? { enum: options as string[] } : {}),
			...(typeof property.description === "string"
				? { description: property.description }
				: {}),
		};
	}
	return {
		type: "object",
		required: [...(raw.required as string[])],
		properties: built,
	};
}

/** The fields request: each choice question under its own name, and the extraction under `fields`. */
export function routeFieldsBody(input: RouteFieldsInput) {
	const questions: Record<string, unknown> = {};
	for (const [name, choice] of Object.entries(input.choices)) {
		if (!routeQuestionName.test(name) || name === "fields")
			throw invalidRequest();
		questions[name] = {
			type: "choice",
			instructions: choice.instructions,
			criteria: criteriaOf(choice.criteria),
		};
	}
	if (input.extract)
		questions.fields = {
			type: "extract",
			instructions: input.extract.instructions,
			schema: schemaOf(input.extract.schema),
		};
	if (Object.keys(questions).length < 1) throw invalidRequest();
	const state = routeState(input);
	return (model: string) => ({ model, state, questions });
}

function failResponse(): never {
	throw invalidResponse();
}
function valueOf(value: unknown, property: Property) {
	if (value === null) return null;
	if (property.type === "string")
		return typeof value === "string" &&
			(!property.enum || property.enum.includes(value))
			? value
			: failResponse();
	if (property.type === "number")
		return typeof value === "number" && Number.isFinite(value)
			? value
			: failResponse();
	return typeof value === "boolean" ? value : failResponse();
}

/** The fields answer, checked against the questions asked. */
export function readRouteFieldsAnswer(
	body: unknown,
	model: string,
	input: RouteFieldsInput,
): RouteFieldsAnswer {
	const answer = object(body);
	assertComplete(answer);
	const answers = object(answer.answers);
	const choices = Object.fromEntries(
		Object.entries(input.choices).map(([name, choice]) => [
			name,
			choiceOf(
				answers[name],
				choice.criteria.map((criterion) => criterion.name),
			),
		]),
	);
	let values: RouteFieldsAnswer["values"] = null;
	let confidence: RouteFieldsAnswer["confidence"] = null;
	if (input.extract) {
		const properties = input.extract.schema.properties;
		const fields = object(answers.fields);
		const given = object(fields.value);
		if (
			!fields.value ||
			typeof fields.value !== "object" ||
			Array.isArray(fields.value) ||
			Object.keys(given).some((key) => !Object.hasOwn(properties, key))
		)
			throw invalidResponse();
		values = Object.fromEntries(
			Object.entries(properties).map(([name, property]) => [
				name,
				Object.hasOwn(given, name) ? valueOf(given[name], property) : null,
			]),
		);
		if (fields.confidence !== undefined && fields.confidence !== null) {
			const scores = object(fields.confidence);
			if (
				typeof fields.confidence !== "object" ||
				Array.isArray(fields.confidence)
			)
				throw invalidResponse();
			confidence = {};
			for (const [name, score] of Object.entries(scores)) {
				if (!Object.hasOwn(properties, name) || !unit(score))
					throw invalidResponse();
				confidence[name] = score;
			}
		}
	}
	return {
		choices,
		values,
		confidence,
		model: modelOf(answer, model),
		headRevision: revision(object(answer.routing).head_revision),
	};
}

/** One fields call; a refusal of the extraction question type is the caller's cue to fill the fields itself. */
export async function requestRouteFields(
	p: Provider,
	input: RouteFieldsInput,
	body: ReturnType<typeof routeFieldsBody>,
	signal: AbortSignal,
	send: (init: RequestInit) => Promise<Response>,
): Promise<RouteFieldsAnswer> {
	let response: Response;
	try {
		response = await send(post(body(p.model)));
	} catch (error) {
		if (
			error instanceof LarmInferenceError &&
			error.status === 400 &&
			error.code === "unsupported_question_type"
		)
			throw new Error(routeErrors.extractUnsupported);
		throw error;
	}
	const json = await readJson(response);
	signal.throwIfAborted();
	return readRouteFieldsAnswer(json, p.model, input);
}

/** The `route` and `routeFields` of a port: both only on a router port, which carries the decision provider alone. */
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
): Pick<LarmPort, "route" | "routeFields"> {
	const call = <T>(
		signal: AbortSignal,
		use: (
			p: Provider,
			scoped: AbortSignal,
			send: (init: RequestInit) => Promise<Response>,
		) => Promise<T>,
	) => {
		const scoped = AbortSignal.any([signal, lifetime]);
		return withProvider("system-one", scoped, (p, connectionId) =>
			use(p, scoped, (init) =>
				judgeInfer(p, "systemone", init, scoped, connectionId),
			),
		);
	};
	return {
		async route(input, signal) {
			if (!decisionOnly) throw new Error(routeErrors.portRequired);
			// A request that breaks the limits is refused before a connection is borrowed.
			const body = routeBody(input);
			return call(signal, (p, scoped, send) =>
				requestRoute(p, input, body, scoped, send),
			);
		},
		async routeFields(input, signal) {
			if (!decisionOnly) throw new Error(routeErrors.portRequired);
			const body = routeFieldsBody(input);
			return call(signal, (p, scoped, send) =>
				requestRouteFields(p, input, body, scoped, send),
			);
		},
	};
}
