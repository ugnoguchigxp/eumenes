import { expect, test } from "bun:test";
import { createLarm, type RouteInput } from "..";
import {
	ROUTE_LIMITS,
	routeErrors,
	type RouteCriterion,
} from "../contracts/route";

/**
 * The router's port (spec router-package-integration 2026-11-04 §1 #4): a connection of the saved router profile that
 * selects its context judgment (the decision provider of capability `decision.context`, whatever the catalog names it)
 * alone; the route body, the strict reading of its answer, and the refusals before anything is sent.
 */
const PROFILE = "router-fixture-profile";
const MODEL = "router-fixture-model";
/** The catalog's name of the context judgment: LARM's, not the host's. */
const NAME = "context-fixture";

function routerLarm(
	options: {
		decisionOnly?: boolean;
		/** The catalog has no context judgment (only the speaking-attitude judge). */
		withoutContext?: boolean;
		answer?: (body: Record<string, any>) => Response;
	} = {},
) {
	const sent: Array<{ auth: string | null; body: Record<string, any> }> = [];
	const calls: string[] = [];
	const asked: unknown[] = [];
	const connection = () => ({
		id: "route1",
		profile: PROFILE,
		agentProfile: PROFILE,
		status: "ready",
		expiresAt: new Date(Date.now() + 900_000).toISOString(),
		providers: [
			{
				name: NAME,
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
								model: "attitude-fixture-model",
							},
							...(options.withoutContext
								? []
								: [
										{
											name: NAME,
											capability: "decision.context",
											protocol: "larm.system-one.v1",
											endpoint: "/v1/systemone",
											model: MODEL,
										},
									]),
						],
					},
				],
			});
		if (url.pathname === "/v1/agent-connections" && init?.method === "POST") {
			asked.push(JSON.parse(String(init.body)).providers);
			return Response.json(connection(), { status: 201 });
		}
		if (url.pathname === "/v1/agent-connections/route1/claim")
			return Response.json({
				...connection(),
				providers: [
					{
						name: NAME,
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
		decisionCapability: "decision.context",
	});
	return { port, sent, calls, asked };
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

test("the context judgment is claimed by its capability; the body keeps the order, carries the newest utterance's head only, and the answer is read whole", async () => {
	const h = routerLarm({ answer: () => answerOf(good) });
	const long = "あ".repeat(2500);
	const answer = await h.port.route!(
		routeInput({ text: long, previousAgent: "い".repeat(300) }),
		signal(),
	);
	expect(h.asked).toEqual([[NAME]]);
	expect(h.sent).toHaveLength(1);
	expect(h.sent[0]!.auth).toBe("Bearer route-secret");
	const body = h.sent[0]!.body;
	expect(Object.keys(body)).toEqual(["model", "state", "questions"]);
	expect(body.model).toBe(MODEL);
	// The context judgment's contract takes the newest utterance only, at its bound.
	expect(body.state).toEqual({ text: "あ".repeat(ROUTE_LIMITS.rerankText) });
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

test("no cut splits a character, and a profile without a context judgment has no router", async () => {
	const h = routerLarm({ answer: () => answerOf(good) });
	await h.port.route!(routeInput({ text: "😀".repeat(500) }), signal());
	expect(h.sent[0]!.body.state.text).toBe("😀".repeat(200));
	await h.port.close();
	const none = routerLarm({
		withoutContext: true,
		answer: () => answerOf(good),
	});
	expect(await failure(none.port.route!(routeInput(), signal()))).toBe(
		"larm_system_one_unavailable",
	);
	expect(none.sent).toEqual([]);
	await none.port.close();
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
		{
			criteria: [
				{
					name: "long",
					description: "あ".repeat(ROUTE_LIMITS.description + 1),
				},
			],
		},
		{ text: "   " },
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

test("a port that is not the router's refuses the call", async () => {
	const h = routerLarm({ decisionOnly: false });
	expect(await failure(h.port.route!(routeInput(), signal()))).toBe(
		routeErrors.portRequired,
	);
	expect(h.calls).toEqual([]);
	await h.port.close();
});
