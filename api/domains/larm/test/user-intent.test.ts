import { expect, test } from "bun:test";
import { createLarm, intentLabels } from "..";

/**
 * The user-intent judge's port (the intent gate design, sections 2 to 4): a connection of the saved intent profile
 * that selects the decision provider alone, claimed, renewed and released; the judge's body and answer; and the
 * separation from the speaking-attitude judge.
 */
const PROFILE = "intent-fixture-profile";
const MODEL = "intent-fixture-model";
const scores = {
	request: 0.81,
	chat: 0.1,
	followup: 0.05,
	noise: 0.02,
	incomplete: 0.02,
};

function intentLarm(
	options: {
		expiryMs?: number;
		answer?: (body: Record<string, unknown>) => Response;
	} = {},
) {
	let expiryMs = options.expiryMs ?? 900_000;
	let tokenVersion = 1;
	const calls: string[] = [];
	const created: Record<string, unknown>[] = [];
	const judged: Array<{ auth: string | null; body: Record<string, unknown> }> =
		[];
	const connection = () => ({
		id: "intent1",
		profile: PROFILE,
		agentProfile: PROFILE,
		status: "ready",
		expiresAt: new Date(Date.now() + expiryMs).toISOString(),
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
		if (url.pathname === "/v3/agent-profiles") {
			expect(url.searchParams.get("profile")).toBe(PROFILE);
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
		}
		if (url.pathname === "/v1/agent-connections" && init?.method === "POST") {
			created.push(JSON.parse(String(init.body)));
			return Response.json(connection(), { status: 201 });
		}
		if (url.pathname === "/v1/agent-connections/intent1/claim")
			return Response.json({
				...connection(),
				providers: [
					{
						name: "system-one",
						protocol: "larm.system-one.v1",
						baseUrl: "http://127.0.0.1/ruri/v1",
						endpoint: "http://127.0.0.1/ruri/v1/systemone",
						model: MODEL,
						credential: { token: `intent-secret-${tokenVersion}` },
						configuration: {
							fields: { daemonURL: "http://127.0.0.1/ruri/v1", model: MODEL },
						},
					},
				],
			});
		if (url.pathname === "/v1/agent-connections/intent1/renew") {
			expiryMs = 900_000;
			tokenVersion++;
			return Response.json(connection());
		}
		if (url.pathname === "/v1/agent-connections/intent1")
			return init?.method === "DELETE"
				? new Response(null, { status: 204 })
				: Response.json(connection());
		if (url.pathname === "/ruri/v1/systemone") {
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			judged.push({
				auth: new Headers(init?.headers).get("Authorization"),
				body,
			});
			return (
				options.answer?.(body) ??
				Response.json({
					model: MODEL,
					answers: { intent: { choice: "request", probabilities: scores } },
					truncated: false,
					history_tokens_dropped: 0,
					state_tokens_dropped: 3,
					routing: { head_revision: "head-7" },
				})
			);
		}
		return Response.json({ error: "not_found" }, { status: 404 });
	};
	const port = createLarm({
		baseUrl: "http://127.0.0.1:9810",
		profile: PROFILE,
		token: "control",
		fetch: fetcher,
		decisionOnly: true,
	});
	return { port, calls, created, judged };
}

const signal = () => new AbortController().signal;

test("the intent port connects to the saved profile with the decision provider alone and judges with its claim", async () => {
	const h = intentLarm();
	const judgment = await h.port.judgeIntent!(
		{
			previousAgent: "何をお手伝いしましょうか？",
			text: "明日の天気を調べてください",
		},
		signal(),
	);
	expect(h.created).toHaveLength(1);
	expect(h.created[0]).toMatchObject({
		profile: PROFILE,
		audience: "saaa-desktop",
		providers: ["system-one"],
	});
	expect(h.judged).toEqual([
		{
			auth: "Bearer intent-secret-1",
			body: {
				model: MODEL,
				state: {
					previous_agent: "何をお手伝いしましょうか？",
					text: "明日の天気を調べてください",
				},
				questions: {
					intent: {
						type: "choice",
						instructions: "最新のユーザー発言の意図を分類してください",
						criteria: {
							request: "依頼",
							chat: "会話",
							followup: "作業への返答",
							noise: "雑音",
							incomplete: "発話途中",
						},
					},
				},
			},
		},
	]);
	expect(judgment).toEqual({
		choice: "request",
		probabilities: scores,
		model: MODEL,
		headRevision: "head-7",
		truncated: false,
		historyTokensDropped: 0,
		stateTokensDropped: 3,
	});
	await h.port.close();
	expect(h.calls).toContain("DELETE /v1/agent-connections/intent1");
});

test("without an agent utterance before it, the state carries the newest utterance alone", async () => {
	const h = intentLarm();
	await h.port.judgeIntent!(
		{ previousAgent: null, text: "こんにちは" },
		signal(),
	);
	expect(h.judged[0]!.body.state).toEqual({ text: "こんにちは" });
	await h.port.close();
});

test("a claim close to its expiry is renewed and claimed again before the next judgement", async () => {
	const h = intentLarm({ expiryMs: 170_000 });
	await h.port.judgeIntent!({ previousAgent: null, text: "一" }, signal());
	await h.port.judgeIntent!({ previousAgent: null, text: "二" }, signal());
	expect(h.calls).toContain("POST /v1/agent-connections/intent1/renew");
	expect(h.judged.map((j) => j.auth)).toEqual([
		"Bearer intent-secret-1",
		"Bearer intent-secret-2",
	]);
	await h.port.close();
});

test("an answer outside the five labels, a missing score or a refused input is an error the caller falls back from", async () => {
	for (const [answer, code] of [
		[
			() =>
				Response.json({
					answers: { intent: { choice: "joy", probabilities: scores } },
				}),
			"larm_invalid_intent_response",
		],
		[
			() =>
				Response.json({
					answers: {
						intent: {
							choice: "chat",
							probabilities: { ...scores, noise: undefined },
						},
					},
				}),
			"larm_invalid_intent_response",
		],
		[
			() =>
				Response.json(
					{ error: { code: "invalid_state", message: "x" } },
					{ status: 422 },
				),
			"",
		],
	] as const) {
		const h = intentLarm({ answer });
		const failed = h.port.judgeIntent!(
			{ previousAgent: null, text: "x" },
			signal(),
		).then(
			() => null,
			(error: Error) => error,
		);
		const error = await failed;
		expect(error).toBeInstanceOf(Error);
		if (code) expect(error!.message).toBe(code);
		await h.port.close();
	}
	expect(intentLabels).toEqual([
		"request",
		"chat",
		"followup",
		"noise",
		"incomplete",
	]);
});

test("each judge answers on its own port only: no credential crosses between the attitude and the intent judge", async () => {
	const h = intentLarm();
	await expect(
		h.port.judge!(
			{ current_chunk: "承知しました" },
			{
				attitude: { type: "choice", instructions: "", criteria: { none: "" } },
			},
			signal(),
		),
	).rejects.toThrow("larm_attitude_port_required");
	const conversation = createLarm({
		baseUrl: "http://127.0.0.1:9810",
		profile: "conversation-profile",
		token: "control",
		fetch: async () => Response.json({}, { status: 500 }),
	});
	await expect(
		conversation.judgeIntent!({ previousAgent: null, text: "x" }, signal()),
	).rejects.toThrow("larm_intent_port_required");
	await conversation.close();
	expect(h.judged).toHaveLength(0);
	await h.port.close();
});
