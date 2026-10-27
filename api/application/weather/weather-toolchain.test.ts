import { expect, test } from "bun:test";
import { harness } from "../toolchain/toolchain.fixture";
import {
	afterUtterance,
	candidatesOf,
	resultField,
	searchThenDelegate,
	toolResults,
	type Candidate,
} from "../toolchain/conversation-script.fixture";
import { waitFor } from "../../infrastructure/wait-for";
import { tomorrowKamakura, weatherFetch } from "./weather.fixture";

const ask = "明日の鎌倉の天気を教えて";
const kamakura = { place: "鎌倉", prefecture: "神奈川県", day: "tomorrow" };
/** The weather toolchain is the instant candidate whose inputs take a place. */
const isWeather = (candidate: Candidate) =>
	candidate.execution === "instant" && candidate.text.includes("place（");

/** The model's usual path: search for the weather toolchain, then answer instantly with the inputs it reads. */
const askWeather = (args: Record<string, unknown> = kamakura) =>
	searchThenDelegate(isWeather, ask, { inputs: args });

async function weatherHarness(
	over: Parameters<typeof weatherFetch>[0] = {},
	extra: Parameters<typeof harness>[0] = {},
	args?: Record<string, unknown>,
) {
	const service = weatherFetch(over);
	const candidates: Array<Candidate[] | undefined> = [];
	const h = await harness({
		weather: { fetch: service.fetch },
		firstRound: (_tools, _question, messages) => {
			candidates.push(candidatesOf(messages));
			return askWeather(args)(messages);
		},
		...extra,
	});
	await h.toolchain.weather!.maintain();
	return { h, service, candidates };
}

test("a cold weather request is answered after one search and one instant answer: fixed sentence, no TODO, no notice", async () => {
	const { h, service, candidates } = await weatherHarness();
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
		// One search, then the instant answer: nothing reached a worker, the web, or a second answer round.
		expect(candidates.filter(Boolean)).toHaveLength(2);
		expect(h.calls).toBe(3);
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
		// The instant answer is traced as a selection of the weather toolchain, completed (no TODO was made for it).
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
		expect(
			h.store.read((db) => h.dialogue.todosInTransaction(db, "main")),
		).toEqual([]);
	} finally {
		await h.close();
	}
});

test("the search lists the weather toolchain as an instant candidate with its place, prefecture and day inputs", async () => {
	const { h, candidates } = await weatherHarness();
	try {
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: ask,
		});
		await h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 });
		const found = candidates.find(Boolean)!;
		const weather = found.find(isWeather);
		expect(weather).toBeDefined();
		// The inputs read as `name（type、required）description` (section 9). The place is the user's own words; the host finds its area.
		expect(weather!.text).toContain("place（string、必須）");
		expect(weather!.text).toContain("prefecture（string、必須）");
		expect(weather!.text).toContain(
			"day（string、必須、値は today・tomorrow・day_after）",
		);
	} finally {
		await h.close();
	}
});

test("without the list of areas the weather toolchain is not among the candidates", async () => {
	const service = weatherFetch({
		areas: () => new Response("", { status: 500 }),
	});
	const candidates: Array<Candidate[] | undefined> = [];
	const h = await harness({
		weather: { fetch: service.fetch },
		firstRound: (_tools, _question, messages) => {
			candidates.push(candidatesOf(messages));
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
		const found = candidates.find(Boolean)!;
		expect(found.some(isWeather)).toBe(false);
		expect(
			service.urls.filter((u) => u.includes("/api/forecast/")),
		).toHaveLength(0);
	} finally {
		await h.close();
	}
});

test("instant inputs outside the schema are refused with the fields to repair, and nothing is fetched", async () => {
	const service = weatherFetch();
	const refusals: string[] = [];
	const g = await harness({
		weather: { fetch: service.fetch },
		firstRound: (_tools, _question, messages) => {
			// The refusal is the tool's result; the agent goes on with it (here it gives up and says so).
			const refused = toolResults(afterUtterance(messages), "delegate");
			if (refused.length) {
				refusals.push(...refused);
				return { text: "天気を取得できませんでした。" };
			}
			return askWeather({ place: "鎌倉", day: "tomorrow" })(messages);
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
		expect(done?.status).toBe("completed");
		expect(refusals).toHaveLength(1);
		expect(resultField(refusals[0]!, "refused")).toBe("true");
		expect(g.dialogue.answerText(run.id)).toBe("天気を取得できませんでした。");
		expect(
			service.urls.filter((u) => u.includes("/api/forecast/")),
		).toHaveLength(0);
	} finally {
		await g.close();
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
