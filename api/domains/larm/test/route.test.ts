import { expect, test } from "bun:test";
import {
	createLarm,
	ROUTE_LIMITS,
	type RouteCriterion,
	type RouteFieldsInput,
	type RouteInput,
} from "..";
import { routeErrors } from "../contracts/route";

/**
 * The router's port (spec toolchain-router-redesign 2026-11-01 §3.2, §3.4; LARM request prompt §2): a connection of
 * the saved router profile that selects the decision provider alone; the route and fields bodies, the strict reading
 * of their answers, and the refusals before anything is sent.
 */
const PROFILE = "router-fixture-profile";
const MODEL = "router-fixture-model";

function routerLarm(
	options: {
		decisionOnly?: boolean;
		answer?: (body: Record<string, any>) => Response;
	} = {},
) {
	const sent: Array<{ auth: string | null; body: Record<string, any> }> = [];
	const calls: string[] = [];
	const connection = () => ({
		id: "route1",
		profile: PROFILE,
		agentProfile: PROFILE,
		status: "ready",
		expiresAt: new Date(Date.now() + 900_000).toISOString(),
		providers: [
			{
				name: "system-one",
				protocol: "larm.system-one.v1",
				endpoint: "/v1/systemone",
				model: MODEL,
				readiness: "ready",
			},
		],
	});
	const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
		if (url.pathname === "/v3/agent-profiles")
			return Response.json({
				contractVersion: "agent-connection.v3",
				catalogRevision: "rev1",
				requestedProfile: PROFILE,
				profiles: [
					{
						id: PROFILE,
						providers: [
							{
								name: "system-one",
								capability: "decision.system-one",
								protocol: "larm.system-one.v1",
								endpoint: "/v1/systemone",
								model: MODEL,
							},
						],
					},
				],
			});
		if (url.pathname === "/v1/agent-connections" && init?.method === "POST")
			return Response.json(connection(), { status: 201 });
		if (url.pathname === "/v1/agent-connections/route1/claim")
			return Response.json({
				...connection(),
				providers: [
					{
						name: "system-one",
						protocol: "larm.system-one.v1",
						baseUrl: "http://127.0.0.1/ruri/v1",
						endpoint: "http://127.0.0.1/ruri/v1/systemone",
						model: MODEL,
						credential: { token: "route-secret" },
						configuration: {
							fields: { daemonURL: "http://127.0.0.1/ruri/v1", model: MODEL },
						},
					},
				],
			});
		if (url.pathname === "/v1/agent-connections/route1")
			return init?.method === "DELETE"
				? new Response(null, { status: 204 })
				: Response.json(connection());
		if (url.pathname === "/ruri/v1/systemone") {
			const body = JSON.parse(String(init?.body)) as Record<string, any>;
			sent.push({
				auth: new Headers(init?.headers).get("Authorization"),
				body,
			});
			return options.answer
				? options.answer(body)
				: Response.json({ error: "unexpected" }, { status: 500 });
		}
		return Response.json({ error: "not_found" }, { status: 404 });
	};
	const port = createLarm({
		baseUrl: "http://127.0.0.1:9810",
		profile: PROFILE,
		token: "control",
		fetch: fetcher,
		decisionOnly: options.decisionOnly ?? true,
	});
	return { port, sent, calls };
}

const signal = () => new AbortController().signal;
const criteria: RouteCriterion[] = [
	{ name: "conversation.respond", description: "話し相手として返事をする" },
	{ name: "music.create", description: "音楽・効果音制作" },
	{ name: "t3.redirect:music.create", description: "直前の依頼をやり直す" },
];
const routeInput = (over: Partial<RouteInput> = {}): RouteInput => ({
	text: "違う、作曲してほしい",
	previousAgent: "曲を流しますね。",
	previousUser: "コーヒータイムにぴったりな音楽をつくって",
	instructions: "どこへ渡すかを選んでください",
	criteria,
	...over,
});
const probabilities = {
	"conversation.respond": 0.1,
	"music.create": 0.3,
	"t3.redirect:music.create": 0.6,
};
const scores = {
	"conversation.respond": 0.05,
	"music.create": 0.88,
	"t3.redirect:music.create": 0.93,
};
const answerOf = (route: Record<string, unknown>, rest = {}) =>
	Response.json({
		model: "long-compatible-name",
		answers: { route },
		routing: { head_revision: "head-1", calibration_revision: "cal-2" },
		truncated: false,
		...rest,
	});
const good = { choice: "t3.redirect:music.create", probabilities, scores };

async function failure(promise: Promise<unknown>) {
	return promise.then(
		() => null,
		(error: Error) => error.message,
	);
}

test("the route body keeps the order, truncates the state and omits empty previous utterances, and the answer is read whole", async () => {
	const h = routerLarm({ answer: () => answerOf(good) });
	const long = "あ".repeat(2500);
	const previous = `${"い".repeat(300)}${"う".repeat(1000)}`;
	const answer = await h.port.route!(
		routeInput({ text: long, previousAgent: previous, previousUser: null }),
		signal(),
	);
	expect(h.sent).toHaveLength(1);
	expect(h.sent[0]!.auth).toBe("Bearer route-secret");
	const body = h.sent[0]!.body;
	expect(Object.keys(body)).toEqual(["model", "state", "questions"]);
	expect(body.model).toBe(MODEL);
	expect(body.state).toEqual({
		previous_agent: "う".repeat(1000),
		text: "あ".repeat(2000),
	});
	expect(Object.keys(body.state)).toEqual(["previous_agent", "text"]);
	expect(body.questions.route.type).toBe("choice");
	expect(Object.keys(body.questions.route.criteria)).toEqual(
		criteria.map((c) => c.name),
	);
	expect(answer).toEqual({
		choice: "t3.redirect:music.create",
		probabilities,
		scores,
		model: "long-compatible-name",
		headRevision: "head-1",
		calibrationRevision: "cal-2",
	});
	await h.port.close();
	expect(h.calls).toContain("DELETE /v1/agent-connections/route1");
});

test("the previous utterance of the user is sent with the others, and no cut splits a character", async () => {
	const h = routerLarm({ answer: () => answerOf(good) });
	await h.port.route!(routeInput(), signal());
	expect(h.sent[0]!.body.state).toEqual({
		previous_agent: "曲を流しますね。",
		previous_user: "コーヒータイムにぴったりな音楽をつくって",
		text: "違う、作曲してほしい",
	});
	await h.port.route!(
		routeInput({ text: "😀".repeat(1500), previousAgent: "😀".repeat(700) }),
		signal(),
	);
	const state = h.sent[1]!.body.state;
	expect(state.text).toBe("😀".repeat(1000));
	expect(state.previous_agent).toBe("😀".repeat(500));
	await h.port.close();
});

test("scores may be absent, but a score outside 0..1 or a missing one is refused", async () => {
	const absent = routerLarm({
		answer: () => answerOf({ choice: good.choice, probabilities }),
	});
	expect((await absent.port.route!(routeInput(), signal())).scores).toBeNull();
	await absent.port.close();
	for (const bad of [
		{ ...scores, "music.create": 1.5 },
		{ "conversation.respond": 0.1, "music.create": 0.2 },
		{ ...scores, extra: 0.2 },
	]) {
		const h = routerLarm({ answer: () => answerOf({ ...good, scores: bad }) });
		expect(await failure(h.port.route!(routeInput(), signal()))).toBe(
			routeErrors.invalidResponse,
		);
		await h.port.close();
	}
});

test("a choice outside the criteria, missing or out-of-range probabilities, or a sum off 1 are invalid responses", async () => {
	for (const route of [
		{ ...good, choice: "weather.forecast" },
		{ ...good, choice: undefined },
		{
			...good,
			probabilities: { "conversation.respond": 0.5, "music.create": 0.5 },
		},
		{ ...good, probabilities: { ...probabilities, "music.create": -0.3 } },
		{
			...good,
			probabilities: { ...probabilities, "music.create": "0.3" },
		},
		{ ...good, probabilities: { ...probabilities, "music.create": 0.5 } },
		{ ...good, probabilities: { ...probabilities, other: 0 } },
	]) {
		const h = routerLarm({ answer: () => answerOf(route) });
		expect(await failure(h.port.route!(routeInput(), signal()))).toBe(
			routeErrors.invalidResponse,
		);
		await h.port.close();
	}
	const near = routerLarm({
		answer: () =>
			answerOf({
				...good,
				probabilities: { ...probabilities, "music.create": 0.305 },
			}),
	});
	expect((await near.port.route!(routeInput(), signal())).choice).toBe(
		good.choice,
	);
	await near.port.close();
	const noRoute = routerLarm({ answer: () => Response.json({ answers: {} }) });
	expect(await failure(noRoute.port.route!(routeInput(), signal()))).toBe(
		routeErrors.invalidResponse,
	);
	await noRoute.port.close();
});

test("a truncated answer or dropped criteria is refused as truncated", async () => {
	for (const rest of [
		{ truncated: true },
		{ criteria_dropped: ["music.create"] },
		{ criteria_dropped: { route: ["music.create"] } },
	]) {
		const h = routerLarm({ answer: () => answerOf(good, rest) });
		expect(await failure(h.port.route!(routeInput(), signal()))).toBe(
			routeErrors.truncated,
		);
		await h.port.close();
	}
	const empty = routerLarm({
		answer: () => answerOf(good, { criteria_dropped: [] }),
	});
	expect((await empty.port.route!(routeInput(), signal())).choice).toBe(
		good.choice,
	);
	await empty.port.close();
});

test("a request that breaks the limits is refused before a connection is made", async () => {
	const many = (n: number) =>
		Array.from({ length: n }, (_, i) => ({
			name: `c${i}`,
			description: "説明",
		}));
	const bad: Array<Partial<RouteInput>> = [
		{ criteria: [] },
		{ criteria: many(ROUTE_LIMITS.criteria + 1) },
		{ criteria: [{ name: "1bad", description: "説明" }] },
		{ criteria: [{ name: "has space", description: "説明" }] },
		{ criteria: [{ name: "a".repeat(97), description: "説明" }] },
		{
			criteria: [
				{ name: "dup", description: "一" },
				{ name: "dup", description: "二" },
			],
		},
		{ criteria: [{ name: "empty", description: "  " }] },
		{ criteria: [{ name: "long", description: "あ".repeat(301) }] },
	];
	for (const over of bad) {
		const h = routerLarm({ answer: () => answerOf(good) });
		expect(await failure(h.port.route!(routeInput(over), signal()))).toBe(
			routeErrors.invalidRequest,
		);
		expect(h.calls).toEqual([]);
		await h.port.close();
	}
	const max = routerLarm({
		answer: (body: Record<string, any>) => {
			const names = Object.keys(body.questions.route.criteria);
			return answerOf({
				choice: names[0],
				probabilities: Object.fromEntries(
					names.map((name) => [name, 1 / names.length]),
				),
			});
		},
	});
	const answer = await max.port.route!(
		routeInput({ criteria: many(ROUTE_LIMITS.criteria) }),
		signal(),
	);
	expect(Object.keys(answer.probabilities)).toHaveLength(128);
	await max.port.close();
});

test("a port that is not the router's refuses both calls", async () => {
	const h = routerLarm({ decisionOnly: false });
	expect(await failure(h.port.route!(routeInput(), signal()))).toBe(
		routeErrors.portRequired,
	);
	expect(
		await failure(
			h.port.routeFields!(
				{
					text: "x",
					previousAgent: null,
					previousUser: null,
					choices: { day: { instructions: "いつ", criteria } },
					extract: null,
				},
				signal(),
			),
		),
	).toBe(routeErrors.portRequired);
	expect(h.calls).toEqual([]);
	await h.port.close();
});

const day: RouteFieldsInput["choices"] = {
	day: {
		instructions: "いつの天気か",
		criteria: [
			{ name: "today", description: "今日" },
			{ name: "tomorrow", description: "明日" },
		],
	},
};
const schema = {
	type: "object" as const,
	required: ["place"],
	properties: {
		place: { type: "string" as const, description: "言われた地名" },
		prefecture: { type: "string" as const },
		kind: { type: "string" as const, enum: ["rain", "snow"] },
		count: { type: "number" as const },
		wet: { type: "boolean" as const },
	},
};
const fieldsInput = (
	over: Partial<RouteFieldsInput> = {},
): RouteFieldsInput => ({
	text: "明日の鎌倉の天気を教えて",
	previousAgent: null,
	previousUser: null,
	choices: day,
	extract: { instructions: "天気を調べる場所", schema },
	...over,
});
const fieldsAnswer = (fields: Record<string, unknown> | null, rest = {}) =>
	Response.json({
		model: MODEL,
		answers: {
			day: { choice: "tomorrow", probabilities: { today: 0.1, tomorrow: 0.9 } },
			...(fields ? { fields } : {}),
		},
		routing: { head_revision: "head-3" },
		...rest,
	});

test("the fields body carries each choice under its own name and the extraction under fields, and the answer is typed", async () => {
	const h = routerLarm({
		answer: () =>
			fieldsAnswer({
				value: { place: "鎌倉", prefecture: null, kind: "rain" },
				confidence: { place: 0.9 },
			}),
	});
	const answer = await h.port.routeFields!(fieldsInput(), signal());
	const body = h.sent[0]!.body;
	expect(Object.keys(body.questions)).toEqual(["day", "fields"]);
	expect(body.questions.day).toEqual({
		type: "choice",
		instructions: "いつの天気か",
		criteria: { today: "今日", tomorrow: "明日" },
	});
	expect(body.questions.fields).toEqual({
		type: "extract",
		instructions: "天気を調べる場所",
		schema,
	});
	expect(body.state).toEqual({ text: "明日の鎌倉の天気を教えて" });
	expect(answer).toEqual({
		choices: { day: "tomorrow" },
		values: {
			place: "鎌倉",
			prefecture: null,
			kind: "rain",
			count: null,
			wet: null,
		},
		confidence: { place: 0.9 },
		model: MODEL,
		headRevision: "head-3",
	});
	await h.port.close();
});

test("without an extraction only the choices are asked and read", async () => {
	const h = routerLarm({ answer: () => fieldsAnswer(null) });
	const answer = await h.port.routeFields!(
		fieldsInput({ extract: null }),
		signal(),
	);
	expect(Object.keys(h.sent[0]!.body.questions)).toEqual(["day"]);
	expect(answer).toMatchObject({
		choices: { day: "tomorrow" },
		values: null,
		confidence: null,
	});
	await h.port.close();
});

test("an unanswered choice, a value of another type, an enum outsider, an extra field or a bad confidence is an invalid response", async () => {
	const bad: Array<Record<string, unknown> | null> = [
		null,
		{ value: "鎌倉" },
		{ value: { place: 3 } },
		{ value: { kind: "hail" } },
		{ value: { count: "3" } },
		{ value: { wet: 1 } },
		{ value: { city: "鎌倉" } },
		{ value: { place: "鎌倉" }, confidence: { place: 2 } },
		{ value: { place: "鎌倉" }, confidence: { city: 0.5 } },
		{ value: { place: "鎌倉" }, confidence: [0.5] },
	];
	for (const fields of bad) {
		const h = routerLarm({ answer: () => fieldsAnswer(fields) });
		expect(await failure(h.port.routeFields!(fieldsInput(), signal()))).toBe(
			routeErrors.invalidResponse,
		);
		await h.port.close();
	}
	const outside = routerLarm({
		answer: () =>
			Response.json({
				answers: {
					day: { choice: "yesterday" },
					fields: { value: { place: "鎌倉" } },
				},
			}),
	});
	expect(
		await failure(outside.port.routeFields!(fieldsInput(), signal())),
	).toBe(routeErrors.invalidResponse);
	await outside.port.close();
	const cut = routerLarm({
		answer: () =>
			fieldsAnswer({ value: { place: "鎌倉" } }, { truncated: true }),
	});
	expect(await failure(cut.port.routeFields!(fieldsInput(), signal()))).toBe(
		routeErrors.truncated,
	);
	await cut.port.close();
});

test("a fields request that is not flat, or names a question badly, is refused before sending", async () => {
	const nested = {
		type: "object" as const,
		required: [],
		properties: { inner: { type: "object" } },
	};
	const bad: Array<Partial<RouteFieldsInput>> = [
		{ choices: {}, extract: null },
		{ choices: { fields: day.day! } },
		{ choices: { "Bad-Name": day.day! } },
		{ choices: { day: { ...day.day!, criteria: [] } } },
		{ extract: { instructions: "x", schema: nested as never } },
		{
			extract: {
				instructions: "x",
				schema: {
					...schema,
					properties: { Place: { type: "string" } },
				},
			},
		},
		{
			extract: {
				instructions: "x",
				schema: {
					...schema,
					properties: { n: { type: "number", enum: ["a"] } },
				},
			},
		},
		{
			extract: {
				instructions: "x",
				schema: { ...schema, required: ["missing"] },
			},
		},
	];
	for (const over of bad) {
		const h = routerLarm({ answer: () => fieldsAnswer(null) });
		expect(
			await failure(h.port.routeFields!(fieldsInput(over), signal())),
		).toBe(routeErrors.invalidRequest);
		expect(h.calls).toEqual([]);
		await h.port.close();
	}
});

test("HTTP 400 unsupported_question_type (LARM's `error.code`) is the extraction being unsupported", async () => {
	for (const body of [
		{ error: { code: "unsupported_question_type", message: "extract" } },
	]) {
		const h = routerLarm({
			answer: () => Response.json(body, { status: 400 }),
		});
		expect(await failure(h.port.routeFields!(fieldsInput(), signal()))).toBe(
			routeErrors.extractUnsupported,
		);
		await h.port.close();
	}
	const other = routerLarm({
		answer: () =>
			Response.json({ error: { code: "invalid_state" } }, { status: 400 }),
	});
	expect(await failure(other.port.routeFields!(fieldsInput(), signal()))).toBe(
		"larm_inference_400",
	);
	await other.port.close();
});
