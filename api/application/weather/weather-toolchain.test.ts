import { expect, test } from "bun:test";
import { harness } from "../toolchain/toolchain.fixture";
import { waitFor } from "../../infrastructure/wait-for";
import { tomorrowKamakura, weatherFetch } from "./weather.fixture";

const ask = "明日の鎌倉の天気を教えて";
const analysis = {
	kind: "live_info",
	freshness: "live",
	impact: "none",
	approved: false,
};
/** The first round calls the weather function, as the model would for a weather request. */
const callsWeather = (
	tools: ReadonlyArray<{ function: { name: string } }>,
	args: Record<string, unknown> = {
		place: "鎌倉",
		prefecture: "神奈川県",
		day: "tomorrow",
	},
) =>
	tools.some((t) => t.function.name === "weather_forecast")
		? { name: "weather_forecast", args: { ...analysis, ...args } }
		: undefined;

async function weatherHarness(
	over: Parameters<typeof weatherFetch>[0] = {},
	extra: Parameters<typeof harness>[0] = {},
	args?: Record<string, unknown>,
) {
	const service = weatherFetch(over);
	const offers: Array<Array<{ name: string; parameters?: any }>> = [];
	const h = await harness({
		weather: { fetch: service.fetch },
		firstRound: (tools) => {
			offers.push(
				tools.map((t) => ({
					name: t.function.name,
					parameters: t.function.parameters,
				})),
			);
			return callsWeather(tools, args);
		},
		...extra,
	});
	await h.toolchain.weather!.maintain();
	return { h, service, offers };
}

test("a weather request is answered from the first round alone: fixed sentence, no second round, no notice", async () => {
	const { h, service, offers } = await weatherHarness();
	try {
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: ask,
		});
		expect(
			(await h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 }))?.status,
		).toBe("completed");
		expect(h.dialogue.answerText(run.id)).toBe(tomorrowKamakura);
		// One model call (the first round); nothing reached a worker, the web, or a second round.
		expect(offers).toHaveLength(1);
		expect(h.calls).toBe(1);
		expect(h.workerContexts).toHaveLength(0);
		expect(h.routeContexts).toHaveLength(0);
		expect(h.acquisitions).toBe(0);
		const final = await (await h.request(`/api/runs/${run.id}`)).json();
		expect(final.announcement ?? null).toBeNull();
		const messages = h.conversation.get("main").messages;
		expect(messages).toHaveLength(2);
		expect(messages.at(-1)!.text).toBe(tomorrowKamakura);
		expect(service.urls.at(-1)).toBe(
			"https://weather.tsukumijima.net/api/forecast/city/140010",
		);
		// The decision is traced as a hand-over to the weather toolchain and completed.
		const traced = h.store.read((db) =>
			db
				.query(
					"SELECT decision,toolchain_id,function_name,outcome FROM toolchain_selections WHERE run_id=?",
				)
				.all(run.id),
		);
		expect(traced).toEqual([
			{
				decision: "toolchain",
				toolchain_id: "weather.forecast",
				function_name: "weather_forecast",
				outcome: "completed",
			},
		]);
	} finally {
		await h.close();
	}
});

test("the first round offers the weather function with the place, its prefecture and the day, and without a notice", async () => {
	const { h, offers } = await weatherHarness();
	try {
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: ask,
		});
		await h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 });
		const weather = offers[0]!.find((t) => t.name === "weather_forecast")!;
		const properties = weather.parameters.properties;
		// The place is the user's own words; the host finds its area.
		expect(properties.place.type).toBe("string");
		expect(properties.place.enum).toBeUndefined();
		expect(properties.prefecture.type).toBe("string");
		expect(properties.day.enum).toEqual(["today", "tomorrow", "day_after"]);
		expect(properties.announcement).toBeUndefined();
		expect(weather.parameters.required).toEqual(
			expect.arrayContaining([
				"kind",
				"freshness",
				"impact",
				"approved",
				"place",
				"prefecture",
				"day",
			]),
		);
		// The other toolchains keep the notice.
		const web = offers[0]!.find((t) => t.name === "web_search")!;
		expect(web.parameters.properties.announcement).toBeDefined();
		expect(web.parameters.properties.place).toBeUndefined();
	} finally {
		await h.close();
	}
});

test("without the list of areas the weather toolchain is not offered", async () => {
	const service = weatherFetch({
		areas: () => new Response("", { status: 500 }),
	});
	const offers: string[][] = [];
	const h = await harness({
		weather: { fetch: service.fetch },
		firstRound: (tools) => {
			offers.push(tools.map((t) => t.function.name));
			return undefined;
		},
	});
	try {
		await h.toolchain.weather!.maintain();
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: ask,
		});
		await h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 });
		expect(offers[0]).not.toContain("weather_forecast");
		expect(offers[0]).toContain("web_search");
	} finally {
		await h.close();
	}
});

test("arguments outside the schema go back for the one structural repair, then fail", async () => {
	const service = weatherFetch();
	let rounds = 0;
	const g = await harness({
		weather: { fetch: service.fetch },
		firstRound: (tools) => {
			rounds++;
			return callsWeather(tools, { place: "鎌倉", day: "tomorrow" });
		},
	});
	try {
		await g.toolchain.weather!.maintain();
		const run = await g.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: ask,
		});
		const done = await g.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 });
		expect(done?.status).toBe("failed");
		expect(rounds).toBe(2);
		expect(
			service.urls.filter((u) => u.includes("/api/forecast/")),
		).toHaveLength(0);
	} finally {
		await g.close();
	}
});

for (const [name, response, args, forecasts] of [
	[
		"a status other than 200",
		() => new Response("down", { status: 503 }),
		undefined,
		1,
	],
	[
		"a body that is not a forecast",
		() => new Response("<html></html>"),
		undefined,
		1,
	],
	[
		"a place the list does not know",
		undefined,
		{ place: "銀座", prefecture: "東京都", day: "tomorrow" },
		0,
	],
] as const)
	test(`${name} switches the same run to web search with the user's words and no notice`, async () => {
		const { h, service } = await weatherHarness(
			{ forecast: response },
			{},
			args,
		);
		try {
			const run = await h.dialogue.submit({
				requestId: crypto.randomUUID(),
				conversationId: "main",
				text: ask,
			});
			const done = await h.dialogue.waitForTerminal(run.id, {
				timeoutMs: 8000,
			});
			expect(done?.status).toBe("completed");
			expect(
				service.urls.filter((u) => u.includes("/api/forecast/")),
			).toHaveLength(forecasts);
			// The web investigation ran for the request as the user said it.
			expect(h.workerContexts.length).toBeGreaterThan(0);
			expect(h.workerContexts[0]).toContain(ask);
			const final = await (await h.request(`/api/runs/${run.id}`)).json();
			expect(final.announcement ?? null).toBeNull();
			// No second round was made to write the request.
			expect(h.routeContexts).toHaveLength(0);
			expect(h.dialogue.answerText(run.id)).not.toBe(tomorrowKamakura);
		} finally {
			await h.close();
		}
	});

test("a spoken weather request is read as the answer, with no notice before it", async () => {
	const { h } = await weatherHarness({}, { voiceText: ask });
	try {
		const session = crypto.randomUUID(),
			utterance = crypto.randomUUID();
		const wav = new Uint8Array(48);
		wav.set(new TextEncoder().encode("RIFF"));
		wav.set(new TextEncoder().encode("WAVE"), 8);
		h.voice.start(session, 1);
		await h.voice.accept(session, 1, 1, utterance, wav);
		await waitFor(() => h.voice.get(utterance)?.status === "input_ready");
		await h.voice.commit(utterance, h.voice.get(utterance)!.revision);
		await waitFor(
			() => ["ready", "failed"].includes(h.voice.get(utterance)?.status ?? ""),
			{ timeout: 4000 },
		).catch(() => {
			throw new Error(
				`speech stage: ${JSON.stringify({ turn: h.voice.get(utterance), spoken: h.spoken })}`,
			);
		});
		const turn = h.voice.get(utterance)!;
		expect(turn.status).toBe("ready");
		expect(h.spoken.join("")).toContain("明日（10/19）の鎌倉市は曇時々晴");
		expect(h.dialogue.answerText(turn.runId!)).toBe(tomorrowKamakura);
		expect(h.workerContexts).toHaveLength(0);
	} finally {
		await h.close();
	}
});
