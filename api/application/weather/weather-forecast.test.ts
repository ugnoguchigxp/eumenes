import { expect, test } from "bun:test";
import { parseAreas } from "./weather-areas";
import { forecastSentence } from "./weather-forecast";
import { areasJson, forecastJson, tomorrowKamakura } from "./weather.fixture";

const kamakura = { name: "鎌倉市", region: "神奈川県東部" };
const areas = () => parseAreas(areasJson);

test("a municipality is found with or without its suffix, and noted with its forecast area", () => {
	for (const place of ["鎌倉", "鎌倉市", " 鎌倉 "])
		expect(areas().resolve(place, "神奈川県")).toEqual({
			...kamakura,
			id: "140010",
		});
	expect(areas().resolve("箱根", "神奈川県")).toEqual({
		name: "箱根町",
		region: "神奈川県西部",
		id: "140020",
	});
});

test("a city split in parts is the city as well", () => {
	expect(areas().resolve("横浜", "神奈川県")).toEqual({
		name: "横浜市",
		region: "神奈川県東部",
		id: "140010",
	});
	expect(areas().resolve("横浜市北部", "神奈川県")?.name).toBe("横浜市北部");
});

test("the prefecture tells apart municipalities of the same name", () => {
	expect(areas().resolve("府中", "広島県")).toEqual({
		name: "府中市",
		region: "広島県南部",
		id: "340010",
	});
	expect(areas().resolve("府中", "東京都")).toEqual({
		name: "府中市",
		region: "東京地方",
		id: "130010",
	});
	expect(areas().resolve("府中市", "東京")?.id).toBe("130010");
});

test("a region, an area or a prefecture is found after the municipalities", () => {
	expect(areas().resolve("三浦半島", "神奈川県")).toEqual({
		name: "三浦半島",
		region: "神奈川県東部",
		id: "140010",
	});
	expect(areas().resolve("神奈川", "神奈川県")).toEqual({
		name: "神奈川県",
		region: "神奈川県東部",
		id: "140010",
	});
	expect(areas().resolve("銀座", "東京都")).toBeUndefined();
});

for (const [name, text] of [
	["text that is not JSON", "<rss></rss>"],
	["no area", JSON.stringify({ class10s: {}, class15s: {}, class20s: {} })],
	[
		"a region whose area is missing",
		JSON.stringify({
			class10s: { "140010": { name: "東部" } },
			class15s: { "140011": { name: "横浜・川崎", parent: "140020" } },
			class20s: {},
		}),
	],
	[
		"an area id of no prefecture",
		JSON.stringify({
			class10s: { "990010": { name: "東部" } },
			class15s: {},
			class20s: {},
		}),
	],
] as const)
	test(`a list with ${name} is refused as a whole`, () => {
		expect(() => parseAreas(text)).toThrow("weather_areas_invalid");
	});

test("the sentence has the fixed form with the announcement time", () => {
	expect(forecastSentence(forecastJson(), "tomorrow", kamakura)).toBe(
		tomorrowKamakura,
	);
});

test("each day is chosen by the service's own label", () => {
	expect(forecastSentence(forecastJson(), "day_after", kamakura)).toBe(
		"明後日（10/20）の鎌倉市は曇り、最高27℃・最低22℃、降水確率は最大40%です（神奈川県東部の予報・5時発表）。",
	);
});

test("a value the service does not give is left out, never filled in", () => {
	// Today: the minimum has passed and the first period has no number.
	expect(forecastSentence(forecastJson(), "today", kamakura)).toBe(
		"今日（10/18）の鎌倉市は晴れ、最高24℃、降水確率は最大0%です（神奈川県東部の予報・5時発表）。",
	);
	const bare = forecastJson([
		{
			date: "2026-10-19",
			dateLabel: "明日",
			telop: "雨",
			min: null,
			max: null,
			rain: ["--%", "--%", "--%", "--%"],
		},
	]);
	expect(forecastSentence(bare, "tomorrow", kamakura)).toBe(
		"明日（10/19）の鎌倉市は雨です（神奈川県東部の予報・5時発表）。",
	);
	expect(
		forecastSentence({ ...bare, publicTime: undefined }, "tomorrow", kamakura),
	).toBe("明日（10/19）の鎌倉市は雨です（神奈川県東部の予報）。");
});

test("the announcement time is read in Japan time", () => {
	expect(
		forecastSentence(
			{ ...forecastJson(), publicTime: "2026-10-17T19:35:00Z" },
			"tomorrow",
			kamakura,
		),
	).toContain("（神奈川県東部の予報・4時35分発表）");
});

for (const [name, body] of [
	["a body that is not a forecast", { forecasts: "none" }],
	["no entry for the day", { forecasts: forecastJson().forecasts.slice(0, 1) }],
	[
		"no weather for the day",
		forecastJson([
			{
				date: "2026-10-19",
				dateLabel: "明日",
				telop: null,
				min: "1",
				max: "2",
				rain: ["0%", "0%", "0%", "0%"],
			},
		]),
	],
	[
		"a date that is not a date",
		{
			forecasts: [{ date: "x", dateLabel: "明日", telop: "晴れ" }],
		},
	],
] as const)
	test(`${name} is refused`, () => {
		expect(() => forecastSentence(body, "tomorrow", kamakura)).toThrow(
			"weather_forecast_invalid",
		);
	});

test("a temperature that is not a number is not spoken", () => {
	const body = forecastJson([
		{
			date: "2026-10-19",
			dateLabel: "明日",
			telop: "晴れ",
			min: "abc",
			max: "26",
			rain: ["--%", "--%", "--%", "--%"],
		},
	]);
	expect(forecastSentence(body, "tomorrow", kamakura)).toBe(
		"明日（10/19）の鎌倉市は晴れ、最高26℃です（神奈川県東部の予報・5時発表）。",
	);
});
