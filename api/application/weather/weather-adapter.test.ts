import { expect, test } from "bun:test";
import { createWeatherAdapter } from "./weather-adapter";
import {
	forecastJson,
	tomorrowKamakura,
	weatherFetch,
} from "./weather.fixture";

const kamakura = { place: "鎌倉", prefecture: "神奈川県", day: "tomorrow" };
const run = (
	adapter: ReturnType<typeof createWeatherAdapter>,
	input: unknown = kamakura,
	signal = new AbortController().signal,
) => adapter.instant!.run("weather.forecast", input, signal);

async function loaded(over: Parameters<typeof weatherFetch>[0] = {}) {
	const service = weatherFetch(over);
	const adapter = createWeatherAdapter({ fetch: service.fetch });
	await adapter.maintain();
	return { adapter, service };
}

test("without the list of areas the toolchain is not available", async () => {
	const service = weatherFetch({
		areas: () => new Response("", { status: 503 }),
	});
	const adapter = createWeatherAdapter({ fetch: service.fetch });
	await adapter.maintain();
	expect(adapter.availableInTransaction({} as never)).toBe(false);
	expect(await run(adapter)).toEqual({ ok: false, code: "invalid_input" });
});

test("a call is answered with the fixed sentence from the forecast of the place's area", async () => {
	const { adapter, service } = await loaded();
	expect(adapter.availableInTransaction({} as never)).toBe(true);
	expect(await run(adapter)).toEqual({ ok: true, answer: tomorrowKamakura });
	expect(service.urls.at(-1)).toBe(
		"https://weather.tsukumijima.net/api/forecast/city/140010",
	);
});

for (const [name, input] of [
	["a day that is not offered", { ...kamakura, day: "yesterday" }],
	["an extra argument", { ...kamakura, hours: 3 }],
	["a missing prefecture", { place: "鎌倉", day: "today" }],
] as const)
	test(`${name} is refused without asking the service`, async () => {
		const { adapter, service } = await loaded();
		const before = service.urls.length;
		expect(await run(adapter, input)).toEqual({
			ok: false,
			code: "invalid_input",
		});
		expect(service.urls).toHaveLength(before);
	});

const failures: Array<[string, () => Response, string]> = [
	[
		"a status other than 200",
		() => new Response("down", { status: 503 }),
		"weather_http_status",
	],
	[
		"a redirect",
		() =>
			new Response(null, {
				status: 302,
				headers: { location: "https://elsewhere.example/" },
			}),
		"weather_http_status",
	],
	[
		"a body that is not JSON",
		() => new Response("<html>"),
		"weather_forecast_invalid",
	],
	[
		"a body without the day",
		() => new Response(JSON.stringify({ forecasts: [] })),
		"weather_forecast_invalid",
	],
	[
		"a body over the size limit",
		() => new Response("x".repeat(600 * 1024)),
		"weather_too_large",
	],
];
for (const [name, response, code] of failures)
	test(`${name} is a failure of the service`, async () => {
		const { adapter } = await loaded({ forecast: response });
		expect(await run(adapter)).toEqual({ ok: false, code });
	});

test("a network error is a failure of the service", async () => {
	const service = weatherFetch();
	const adapter = createWeatherAdapter({
		fetch: (async (input: string | URL | Request) => {
			if (String(input).includes("/api/forecast/"))
				throw new Error("ECONNRESET");
			return service.fetch(input);
		}) as typeof fetch,
	});
	await adapter.maintain();
	expect(await run(adapter)).toEqual({
		ok: false,
		code: "weather_unreachable",
	});
});

test("a cancelled run ends the wait and is not a failure of the service", async () => {
	const service = weatherFetch();
	const adapter = createWeatherAdapter({
		fetch: ((input: string | URL | Request, init?: RequestInit) => {
			if (!String(input).includes("/api/forecast/"))
				return service.fetch(input);
			return new Promise<Response>((_, reject) =>
				init!.signal!.addEventListener("abort", () =>
					reject(init!.signal!.reason),
				),
			);
		}) as typeof fetch,
	});
	await adapter.maintain();
	const started = Date.now();
	const controller = new AbortController();
	const pending = run(adapter, kamakura, controller.signal);
	controller.abort(new Error("cancelled"));
	await expect(pending).rejects.toThrow("cancelled");
	expect(Date.now() - started).toBeLessThan(2000);
});

test("redirects are never followed and requests carry a signal", async () => {
	const seen: RequestInit[] = [];
	const service = weatherFetch();
	const adapter = createWeatherAdapter({
		fetch: (async (input: string | URL | Request, init?: RequestInit) => {
			seen.push(init!);
			return service.fetch(input);
		}) as typeof fetch,
	});
	await adapter.maintain();
	await run(adapter);
	expect(seen).toHaveLength(2);
	for (const init of seen) {
		expect(init.redirect).toBe("manual");
		expect(init.signal).toBeInstanceOf(AbortSignal);
	}
});

test("the list is read again after a day, and a failed read keeps the earlier list", async () => {
	let clock = 1_000_000;
	let failing = false;
	const service = weatherFetch({
		areas: () =>
			failing
				? new Response("", { status: 500 })
				: new Response(
						JSON.stringify({
							class10s: { "140010": { name: "東部" } },
							class15s: {},
							class20s: {},
						}),
					),
	});
	const adapter = createWeatherAdapter({
		fetch: service.fetch,
		now: () => clock,
	});
	await adapter.maintain();
	expect(adapter.availableInTransaction({} as never)).toBe(true);
	const reads = () =>
		service.urls.filter((u) => u.endsWith("/area.json")).length;
	expect(reads()).toBe(1);
	// Within the day nothing is read.
	clock += 3_600_000;
	await adapter.maintain();
	expect(reads()).toBe(1);
	// After the day the list is read; a failure leaves the earlier one standing and waits before retrying.
	failing = true;
	clock += 24 * 3_600_000;
	await adapter.maintain();
	expect(reads()).toBe(2);
	expect(adapter.availableInTransaction({} as never)).toBe(true);
	await adapter.maintain();
	expect(reads()).toBe(2);
	clock += 61_000;
	failing = false;
	await adapter.maintain();
	expect(reads()).toBe(3);
});

test("the weather itself is what matters: today without a minimum still answers", async () => {
	const { adapter } = await loaded({
		forecast: () => new Response(JSON.stringify(forecastJson())),
	});
	const today = await run(adapter, { ...kamakura, day: "today" });
	expect(today).toEqual({
		ok: true,
		answer:
			"今日（10/18）の鎌倉市は晴れ、最高24℃、降水確率は最大0%です（神奈川県東部の予報・5時発表）。",
	});
});

test("a place the list does not know is a failure, without asking the service", async () => {
	const { adapter, service } = await loaded();
	const before = service.urls.length;
	expect(
		await run(adapter, { place: "銀座", prefecture: "東京都", day: "today" }),
	).toEqual({ ok: false, code: "weather_place_unknown" });
	expect(service.urls).toHaveLength(before);
});
