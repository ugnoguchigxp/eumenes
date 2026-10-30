import { expect, test } from "bun:test";
import {
	toolchainPassages,
	type VectorSpace,
} from "../../api/domains/capabilities";
import type { LarmPort } from "../../api/domains/larm";
import {
	acceptReport,
	expectationJudge,
	judgeAccept,
	judgmentOf,
	offeredOf,
	runAcceptChain,
	userWords,
	type AcceptBase,
	type AcceptPorts,
	type Observed,
} from "./harness-accept";
import { ACCEPT_CHAINS, CHAINS, type AcceptChain } from "./harness-chains";
import { parseOptions, withStandIns } from "./harness";

/**
 * The acceptance lane on the app's test base with a scripted model and a fixed embedding: a lane run where the
 * product and the model do each scene right passes, and each defect of the review intake plan (section 6.4), put in
 * one at a time, is caught. No LARM is called.
 */

type Schema = Record<string, unknown>;
const chain = (key: string): AcceptChain =>
	[...CHAINS, ...ACCEPT_CHAINS].find((c) => c.key === key)!;

/** The values a choice branch offers for one field. */
function enumOf(schema: Schema, choice: string, field: string): string[] {
	const branches = (schema.anyOf ?? []) as Array<{
		properties: Record<string, { enum?: string[] }>;
	}>;
	return (
		branches.find((b) => b.properties.choice?.enum?.includes(choice))
			?.properties[field]?.enum ?? []
	);
}

/** A conversation model whose choice is `choose`'s and whose talk is one fixed line. */
function scripted(
	choose: (
		offered: string[],
		schema: Schema,
		words: string,
		/** The choice's whole last message (`## Memory`, `## Earlier`, `## State`, … `## User`). */
		input: string,
	) => Record<string, unknown>,
): LarmPort {
	return {
		status: () => ({ state: "ready", capabilities: ["llm"] }),
		connect: async () => {},
		close: async () => {},
		transcribe: async () => "",
		speak: async () => new Uint8Array(),
		answer: async (messages, _signal, options) =>
			options?.jsonSchema
				? JSON.stringify(
						choose(
							offeredOf(options.jsonSchema),
							options.jsonSchema as Schema,
							userWords(messages),
							messages.at(-1)?.content ?? "",
						),
					)
				: "承知しました。",
	};
}

const KAMAKURA = { place: "鎌倉", prefecture: "神奈川県", day: "tomorrow" };

/** The choices of a model that reads each scene right (`inputs`: what it gives the weather). */
const right =
	(inputs: Record<string, unknown> = KAMAKURA) =>
	(offered: string[], schema: Schema, words: string) => {
		if (offered.includes("approve"))
			return {
				choice: "approve",
				confirmation: enumOf(schema, "approve", "confirmation")[0],
			};
		if (/天気/.test(words) && offered.includes("weather.forecast"))
			return { choice: "weather.forecast", inputs };
		if (/アンケート/.test(words) && offered.includes("ui.compose"))
			return {
				choice: "ui.compose",
				say: "直します。",
				request: "来場者アンケートに年代を聞く質問を足す",
				// The scene changes a saved item: the first item after `new`.
				target: enumOf(schema, "ui.compose", "target").find((t) => t !== "new"),
			};
		if (/猫/.test(words) && offered.includes("image.create"))
			return { choice: "image.create", say: "描きます。", request: "猫の絵" };
		return { choice: "none" };
	};

/** One axis per scene's toolchain, and one for every other. */
const AXES = ["weather.forecast", "ui.compose", "image.create"] as const;
const space: VectorSpace = {
	modelId: "fixture-embedding",
	revision: "r1",
	artifactDigest: "d1",
	dimension: AXES.length + 1,
};
const axis = (i: number, sign = 1) =>
	Array.from({ length: space.dimension }, (_, j) => (j === i ? sign : 0));
const OTHER = axis(AXES.length);
/** A query's vector: the axis of the toolchain its words name. */
const embed: NonNullable<AcceptPorts["embed"]> = async (texts, type) => ({
	vectors: texts.map((text) => {
		if (type === "passage") return OTHER;
		const at = [/天気/, /アンケート|ランディング/, /猫|絵/].findIndex((w) =>
			w.test(text),
		);
		return at < 0 ? OTHER : axis(at);
	}),
	space,
});

/** The index of the scenes: each scene's toolchain on its axis (`far`: those placed opposite, out of the search). */
function index(far: readonly string[] = []) {
	return (base: AcceptBase) => {
		const active = base.store.read((db) =>
			base.toolchain.capabilities.toolchainsInTransaction(db),
		);
		return base.store.write((db) =>
			base.toolchain.capabilities.saveToolchainVectorsInTransaction(
				db,
				space,
				active.flatMap((d) => {
					const at = AXES.indexOf(d.id as (typeof AXES)[number]);
					const vector = at < 0 ? OTHER : axis(at, far.includes(d.id) ? -1 : 1);
					return toolchainPassages(d).map((text, item) => ({
						revisionId: d.revisionId,
						item,
						text,
						vector,
					}));
				}),
			),
		);
	};
}

const ports = (over: Partial<AcceptPorts> = {}): AcceptPorts => ({
	main: scripted(right()),
	judge: expectationJudge,
	embed,
	intent: { profile: "fixture", searchScore: 0.6, timeoutMs: 1500 },
	prepare: index(),
	stepMs: 10_000,
	...over,
});

test("scenes the product and the model do right pass: an instant answer, a confirmation and its approval with the item, and the answer to a planted question", async () => {
	const weather = await runAcceptChain(ports(), chain("accept-weather"), 0);
	expect(weather.map((r) => [r.pass, r.why])).toEqual([[true, ""]]);
	expect(weather[0]).toMatchObject({
		route: "search",
		judgment: "request",
		handed: { toolchain: "weather.forecast" },
	});
	const target = await runAcceptChain(ports(), chain("accept-target"), 0);
	expect(target.map((r) => [r.pass, r.why])).toEqual([
		[true, ""],
		[true, ""],
	]);
	expect(target[1]!.handed).toMatchObject({ toolchain: "ui.compose" });
	// The question back is planted through the product: the first step's choice reads it as the request asked about.
	const inputs: string[] = [];
	const answer = await runAcceptChain(ports(), chain("answer-picture"), 0, {
		steps: 1,
		inputs: (_index, calls) =>
			inputs.push(...calls.map((c) => c.messages.at(-1)!.content)),
	});
	expect(answer.map((r) => [r.pass, r.why])).toEqual([[true, ""]]);
	expect(inputs[0]).toContain("聞き返した依頼: 絵を描いて");
}, 60_000);

test("a request to make something new is handed to the studio at once, and the work opens on no saved item", async () => {
	const studio = (offered: string[], schema: Schema, words: string) =>
		/ランディング/.test(words) && offered.includes("ui.compose")
			? {
					choice: "ui.compose",
					say: "作りますね。",
					request: "イヤホンのランディングページを作る",
					target: enumOf(schema, "ui.compose", "target")[0],
				}
			: right()(offered, schema, words);
	const [record] = await runAcceptChain(
		ports({ main: scripted(studio) }),
		chain("accept-new"),
		0,
	);
	expect([record!.pass, record!.why]).toEqual([true, ""]);
	expect(record!.handed).toMatchObject({ toolchain: "ui.compose" });
	expect(record!.opened).toEqual([null]);
}, 30_000);

test("a judge that routes every utterance to the talk turn is caught", async () => {
	const [record] = await runAcceptChain(
		ports({ judge: async () => judgmentOf("chat") }),
		chain("accept-weather"),
		0,
	);
	expect(record).toMatchObject({
		pass: false,
		why: "会話の回へ振り分けた",
		route: "answer",
	});
}, 30_000);

test("a toolchain the index lost is caught as missing from the candidates", async () => {
	const [record] = await runAcceptChain(
		ports({ prepare: index(["weather.forecast"]) }),
		chain("accept-weather"),
		0,
	);
	expect(record).toMatchObject({
		pass: false,
		why: "候補になし weather.forecast",
	});
	expect(record!.offered).not.toContain("weather.forecast");
}, 30_000);

test("weather inputs without the place are refused by the host's check and caught", async () => {
	const { place: _place, ...placeless } = KAMAKURA;
	const [record] = await runAcceptChain(
		ports({ main: scripted(right(placeless)) }),
		chain("accept-weather"),
		0,
	);
	expect(record!.pass).toBe(false);
	expect(record!.why).toStartWith("即答なし（断り");
	expect(record!.retries).toBeGreaterThan(0);
}, 30_000);

test("an approval whose hand-over loses the item is caught where the work opens", async () => {
	const records = await runAcceptChain(
		ports({
			prepare: async (base) => {
				await index()(base);
				// The defect: what the approval hands over reaches the work without its item.
				const ui = base.uiCompositions!;
				const open = ui.openWorkInTransaction;
				ui.openWorkInTransaction = (db, input) =>
					open(db, { ...input, targetRef: null });
			},
		}),
		chain("accept-target"),
		0,
	);
	expect(records.map((r) => [r.pass, r.why])).toEqual([
		[true, ""],
		[false, "対象が渡らない"],
	]);
	expect(records[1]!.opened).toEqual([null]);
}, 30_000);

test("a preference said past the earlier words reaches the request through `## Memory`, and is missed without it", async () => {
	// The model writes the colour only when its input holds it.
	const flower = (
		offered: string[],
		schema: Schema,
		words: string,
		input: string,
	) =>
		/花の絵/.test(words) && offered.includes("image.create")
			? {
					choice: "image.create",
					say: "描きます。",
					request: /好きな色は藍色/.test(input) ? "藍色の花の絵" : "花の絵",
				}
			: right()(offered, schema, words);
	const inputs: string[] = [];
	const [kept] = await runAcceptChain(
		ports({ main: scripted(flower) }),
		chain("accept-memory"),
		0,
		{
			inputs: (_index, calls) =>
				inputs.push(...calls.map((c) => c.messages.at(-1)!.content)),
		},
	);
	expect([kept!.pass, kept!.why]).toEqual([true, ""]);
	expect(inputs[0]).toStartWith("## Memory\n");
	expect(inputs[0]).toContain("好きな色は藍色");
	expect(inputs[0]).not.toContain("- 好きな色は藍色です");
	const { remembered: _remembered, ...unremembered } = chain("accept-memory");
	const [missed] = await runAcceptChain(
		ports({ main: scripted(flower) }),
		unremembered,
		0,
	);
	expect(missed!.pass).toBe(false);
}, 60_000);

test("--lane accept runs the chains and the scenes it adds, on the saved LARM connection, with its judge", () => {
	const o = parseOptions(["--lane", "accept"]);
	expect(o).toMatchObject({ lane: "accept", judge: "ruri" });
	expect(o.chains.map((c) => c.key)).toEqual(
		[...CHAINS, ...ACCEPT_CHAINS].map((c) => c.key),
	);
	expect(
		parseOptions([
			"--lane",
			"accept",
			"--judge",
			"expect",
			"--chains",
			"accept-target,topic",
		]).chains.map((c) => c.key),
	).toEqual(["accept-target", "topic"]);
	expect(parseOptions([]).lane).toBe("choice");
	expect(() => parseOptions(["--chains", "accept-target"])).toThrow(
		"unknown chain",
	);
	expect(() =>
		parseOptions(["--lane", "accept", "--client", "codex", "--model", "m"]),
	).toThrow("--lane accept runs");
	expect(() => parseOptions(["--lane", "accept", "--forms", "empty"])).toThrow(
		"does not apply",
	);
	expect(() => parseOptions(["--judge", "expect"])).toThrow("--judge applies");
	expect(() => parseOptions(["--lane", "x"])).toThrow("--lane is");
	expect(() => parseOptions(["--lane", "accept", "--judge", "x"])).toThrow(
		"--judge is",
	);
});

test("the chooser report says what it stands in for, between its settings and its results", () => {
	const lines = withStandIns("# 測定\n\n| 項目 | 値 |\n\n## 合否\nx").split(
		"\n",
	);
	const standIns = lines.findIndex((l) => l.startsWith("## 代用"));
	expect(standIns).toBe(4);
	expect(lines.indexOf("## 合否")).toBeGreaterThan(standIns);
	expect(
		lines.filter((l) => l.startsWith("- 判定: ステップの期待")),
	).toHaveLength(1);
});

test("an approval is judged on its hand-over whatever the routing (the pending turn comes first)", () => {
	const seen: Observed = {
		route: "answer",
		judgment: "followup",
		choices: [
			{
				round: "pending",
				offered: ["none", "approve", "decline"],
				answer: JSON.stringify({ choice: "approve", confirmation: "c1" }),
				retry: false,
			},
		],
		talks: 0,
		said: "",
		handed: { toolchain: "ui.compose", request: "年代を聞く質問を足す" },
		opened: ["saved-1"],
		confirmed: [],
		instants: [],
		work: [],
		error: null,
	};
	const step = {
		say: "はい",
		approve: { toolchain: "ui.compose", target: "来場者アンケート" },
	};
	const context = { saved: { 来場者アンケート: "saved-1" }, lastAgent: "" };
	expect(judgeAccept(step, seen, context)).toEqual({ pass: true, why: "" });
	expect(judgeAccept(step, { ...seen, opened: [null] }, context)).toEqual({
		pass: false,
		why: "対象が渡らない",
	});
});

test("a scene that stopped is told among the failures of the report, which is still written", () => {
	const report = acceptReport(
		{
			startedAt: "2026-10-31T00:00:00.000Z",
			judge: "expect",
			searchScore: 0.6,
			reps: 1,
			chains: ["記憶の好み"],
			settings: null,
			stopped: [
				{ chain: "記憶の好み", rep: 0, reason: "accept_plant_step_timeout" },
			],
		},
		[],
	);
	expect(report).toContain(
		"- 記憶の好み 回1: 途中で止まった（accept_plant_step_timeout）",
	);
	expect(report).not.toContain("\nなし");
});
