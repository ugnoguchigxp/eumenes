import { expect, test } from "bun:test";
import type { ToolchainCard } from "../../capabilities";
import {
	analysisTools,
	analysisTrace,
	validateAnalysis,
} from "../service/initial-decision";

const base = {
	revisionId: "toolchain:t@1",
	title: "t",
	summary: "目的",
	useWhen: ["場面"],
	redirects: [],
	score: { rank: 1, ftsRank: 1, similarity: null, fromHistory: false },
};
const ordinary: ToolchainCard = {
	...base,
	id: "web.search",
	functionName: "web_search",
};
const areas = ["神奈川県 横浜", "道北 稚内"];
const instant: ToolchainCard = {
	...base,
	revisionId: "toolchain:weather.forecast@1",
	id: "weather.forecast",
	functionName: "weather_forecast",
	instant: {
		parameters: {
			type: "object",
			properties: {
				area: { type: "string", enum: areas },
				day: { type: "string", enum: ["today", "tomorrow", "day_after"] },
			},
			required: ["area", "day"],
			additionalProperties: false,
		},
		parse: (args) => {
			const a = args as { area?: string; day?: string };
			return areas.includes(a.area ?? "") &&
				["today", "tomorrow", "day_after"].includes(a.day ?? "") &&
				Object.keys(a).length === 2
				? { ok: true, value: a }
				: { ok: false };
		},
	},
};
const analysis = {
	kind: "live_info",
	freshness: "live",
	impact: "none",
	approved: false,
};
const call = (args: unknown) => [
	{ id: "c", name: "weather_forecast", arguments: JSON.stringify(args) },
];

test("an instant toolchain's function takes the analysis and its own arguments, and no notice", () => {
	const tools = analysisTools([instant, ordinary]);
	const parameters = (name: string) =>
		tools.find((t) => t.function.name === name)!.function.parameters as {
			properties: Record<string, { enum?: string[] }>;
			required: string[];
			additionalProperties: boolean;
		};
	const weather = parameters("weather_forecast");
	expect(Object.keys(weather.properties).sort()).toEqual(
		["approved", "area", "day", "freshness", "impact", "kind"].sort(),
	);
	expect(weather.properties.area!.enum).toEqual(areas);
	expect(weather.required).toEqual(
		expect.arrayContaining(["kind", "area", "day"]),
	);
	expect(weather.additionalProperties).toBe(false);
	// The others are unchanged: a notice, and none of the weather arguments.
	const web = parameters("web_search");
	expect(web.properties.announcement).toBeDefined();
	expect(web.properties.area).toBeUndefined();
});

test("no area is offered when the weather toolchain is not among the candidates", () => {
	const text = JSON.stringify(analysisTools([ordinary]));
	expect(text).not.toContain("area");
	expect(text).not.toContain("tomorrow");
});

test("a call of the instant function becomes the toolchain's arguments with the analysis kept", () => {
	const round = validateAnalysis(
		call({ ...analysis, area: "神奈川県 横浜", day: "tomorrow" }),
		[instant, ordinary],
	);
	expect(round).toMatchObject({
		next: "instant",
		kind: "live_info",
		arguments: { area: "神奈川県 横浜", day: "tomorrow" },
	});
	// The trace keeps the vocabulary of the history: the request went to a toolchain.
	expect(analysisTrace(round).next).toBe("toolchain");
});

for (const [name, extra] of [
	["an area outside the host's list", { area: "東京都 東京", day: "today" }],
	["a day that is not offered", { area: "神奈川県 横浜", day: "next_week" }],
	["no area", { day: "today" }],
	[
		"a notice the function does not take",
		{ area: "神奈川県 横浜", day: "today", announcement: "お調べします。" },
	],
] as const)
	test(`${name} is a contract violation`, () => {
		expect(() =>
			validateAnalysis(call({ ...analysis, ...extra }), [instant, ordinary]),
		).toThrow();
	});

test("a request that must be handed over cannot be answered from hand even with instant toolchains offered", () => {
	expect(() =>
		validateAnalysis(
			[{ id: "c", name: "answer", arguments: JSON.stringify(analysis) }],
			[instant],
		),
	).toThrow();
});
