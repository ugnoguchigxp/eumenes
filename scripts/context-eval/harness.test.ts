import { describe, expect, test } from "bun:test";
import { systemCopyCheck } from "../../api/domains/dialogue/service/conversation-output";
import {
	cloudHarness,
	localHarness,
} from "../../api/domains/dialogue/service/harness";
import {
	CHAINS,
	candidatesFor,
	CARD_IDS,
	type Card,
	type Step,
} from "./harness-chains";
import type { CallKind, CallMetrics, TaggedCall } from "./harness-client";
import { readStreamLine, finishMetrics } from "./harness-client";
import {
	buildSystem,
	composeInput,
	lastLines,
	utterancesOf,
	workLines,
	type Entry,
	type SystemSource,
} from "./harness-compose";
import {
	cellOf,
	commonRun,
	judgeStep,
	reportMarkdown,
	timingOf,
	type StepRecord,
	type Turn,
} from "./harness-judge";
import { cardOf, systemFieldsOf, titlesOf } from "./harness-source";
import { parseOptions, planOf, startLog } from "./harness";

const source: SystemSource = {
	persona: { agentName: "", userName: "", persona: "butler" },
	interests: [],
	emotion: false,
	titles: ["画像生成", "音楽・効果音制作"],
};
const system = buildSystem(source, localHarness);
const never = () => false;
const ctx = { copies: never, lastAgent: "" };
const turn = (extra: Partial<Turn>): Turn => ({
	said: "",
	acted: false,
	...extra,
});
const expectStep: Step = {
	say: "x",
	expect: { toolchain: "image.create", has: /猫/, not: /カエル/ },
};

describe("judgeStep", () => {
	test("a hand-over passes only for the toolchain and the request the step expects", () => {
		const handed = (toolchain: string, request: string) =>
			judgeStep(
				expectStep,
				turn({ acted: true, delegated: { toolchain, request } }),
				ctx,
			);
		expect(handed("image.create", "猫の絵").pass).toBe(true);
		expect(handed("music.create", "猫の絵").why).toBe("担当違い music.create");
		expect(handed("image.create", "犬の絵").why).toBe("依頼の中身違い");
		expect(handed("image.create", "猫とカエルの絵").why).toBe(
			"前の依頼が混ざった",
		);
	});
	test("a search without a hand-over, a reply without a call, and a call that errored fail", () => {
		expect(judgeStep(expectStep, turn({ acted: true }), ctx).why).toBe(
			"探したが頼まなかった",
		);
		expect(judgeStep(expectStep, turn({}), ctx).why).toBe("呼ばずに返事");
		expect(judgeStep(expectStep, turn({ error: "boom" }), ctx).why).toBe(
			"error boom",
		);
	});
	test("a reply that copies the system part fails before anything else is judged", () => {
		const copies = systemCopyCheck(system);
		const rule = system
			.split("\n")
			.find((l) => l.startsWith("- 返事は利用者の言語で"))!;
		const verdict = judgeStep(
			{ say: "x", free: true },
			turn({ said: rule.slice(2) }),
			{
				copies,
				lastAgent: "",
			},
		);
		expect(verdict).toEqual({ pass: false, why: "system を写した" });
		expect(
			judgeStep({ say: "x", free: true }, turn({ said: "はい、どうぞ。" }), {
				copies,
				lastAgent: "",
			}).pass,
		).toBe(true);
	});
	test("chat steps pass without a call, the broken reply must not come back, a re-saying repeats the last reply", () => {
		expect(judgeStep({ say: "ありがとう" }, turn({}), ctx).pass).toBe(true);
		expect(
			judgeStep({ say: "ありがとう" }, turn({ acted: true }), ctx).why,
		).toBe("雑談で担当を呼んだ");
		const broken: Step = { say: "x", notBroken: true };
		expect(
			judgeStep(
				broken,
				turn({ said: "先ほどの再生は記憶にない内容でした" }),
				ctx,
			).why,
		).toBe("壊れた返事を繰り返した");
		expect(judgeStep(broken, turn({ said: "火曜です。" }), ctx).pass).toBe(
			true,
		);
		const again: Step = { say: "x", repeatOf: true };
		const last = "おすすめは、雨に唄えば、です。";
		expect(
			judgeStep(again, turn({ said: "雨に唄えば、です。" }), {
				copies: never,
				lastAgent: last,
			}).pass,
		).toBe(true);
		expect(
			judgeStep(again, turn({ said: "別の映画です。" }), {
				copies: never,
				lastAgent: last,
			}).why,
		).toBe("前の答えと違う");
		expect(judgeStep(again, turn({ said: "あ" }), ctx).why).toBe(
			"前の答えなし",
		);
	});
	test("commonRun finds the longest shared run", () => {
		expect(commonRun("abcdef", "xxcdexx")).toBe(3);
		expect(commonRun("", "abc")).toBe(0);
	});
});

describe("chains", () => {
	test("the scratch's six chains and the three answer chains, each step with something to judge", () => {
		expect(CHAINS.map((c) => c.key)).toEqual([
			"sequence",
			"report",
			"topic",
			"reword",
			"promise",
			"broken",
			"answer-picture",
			"answer-mood",
			"answer-offer",
		]);
		for (const chain of CHAINS) expect(chain.steps.length).toBeGreaterThan(0);
	});
	test("a search is answered from the saved cards by the words of its query", () => {
		const cards = Object.fromEntries(
			CARD_IDS.map((id): [string, Card] => [
				id,
				{ id, title: id, summary: "", useWhen: [] },
			]),
		);
		expect(candidatesFor(cards, "画像 猫").map((c) => c.id)).toEqual([
			"image.create",
			"model3d.studio",
			"excalidraw.edit",
		]);
		expect(candidatesFor(cards, "曲の再生").map((c) => c.id)[0]).toBe(
			"music.library",
		);
		expect(candidatesFor(cards, "効果音 作る")[0]).toMatchObject({
			id: "music.create",
			execution: "background",
		});
		expect(candidatesFor(cards, "天気")[0]!.id).toBe("web.search");
		expect(() => candidatesFor({}, "画像")).toThrow("harness_card_missing");
	});
});

describe("utterancesOf", () => {
	const call = { name: "find_toolchain", arguments: "{}", result: "{}" };
	test("a notice belongs to the agent utterance after it, tool calls to the agent's", () => {
		const log: Entry[] = [
			{ role: "agent", text: "こんにちは。" },
			{ role: "user", text: "曲を作って" },
			{ role: "agent", text: "承りました。", toolCalls: [call] },
			{ role: "notice", text: "[ホストの知らせ] t1 終わりました" },
			{ role: "agent", text: "できました。" },
		];
		const u = utterancesOf(log);
		expect(u.map((x) => x.seq)).toEqual([1, 2, 3, 4]);
		expect(u[2]!.toolCalls).toEqual([call]);
		expect(u[2]!.notice).toBeNull();
		expect(u[3]!.notice).toBe("[ホストの知らせ] t1 終わりました");
		expect(u[1]!.toolCalls).toEqual([]);
	});
});

describe("composeInput", () => {
	const log: Entry[] = [
		...startLog(CHAINS.find((c) => c.key === "sequence")!),
		{ role: "user", text: "猫の絵作って" },
		{
			role: "agent",
			text: "承りました。",
			toolCalls: [
				{
					name: "find_toolchain",
					arguments: '{"query":"画像"}',
					result: '{"candidates":[]}',
				},
				{
					name: "delegate",
					arguments: '{"toolchain":"image.create"}',
					result: '{"todo":"t1"}',
				},
			],
		},
	];
	const compose = (
		form: "current" | "empty" | "empty-last",
		harness = localHarness,
	) =>
		composeInput({
			form,
			harness,
			system,
			log,
			works: [{ ref: 1, title: "猫の絵", state: "running" }],
			presented: null,
			say: "カエルの絵を作って",
		});
	test("current: system, memory, the recent conversation with the tool exchange, then State and User", () => {
		const m = compose("current");
		expect(m[0]).toEqual({ role: "system", content: system });
		expect(m[1]).toEqual({ role: "user", content: "## Memory\n- なし" });
		expect(m.map((x) => x.role)).toEqual([
			"system",
			"user",
			"assistant",
			"user",
			"assistant",
			"tool",
			"assistant",
			"tool",
			"assistant",
			"user",
		]);
		expect(m[4]!.tool_calls![0]!.id).toBe("u3-1");
		expect(m.at(-1)!.content).toBe(
			"## State\n今: 10-28（水）10:00\n仕事:\n- t1 猫の絵 実行中\n\n## User\nカエルの絵を作って",
		);
		for (let i = 1; i < m.length; i++)
			if (m[i]!.role === "user") expect(m[i - 1]!.role).not.toBe("user");
	});
	test("empty: only the system and one last message, without memory or recent conversation", () => {
		const m = compose("empty");
		expect(m).toHaveLength(2);
		expect(m[1]!.content).not.toContain("## Memory");
		expect(m[1]!.content).not.toContain("直前");
	});
	test("empty-last adds the user's last words and the agent's last reply as State lines", () => {
		const m = compose("empty-last");
		expect(m).toHaveLength(2);
		expect(m[1]!.content).toContain("直前の利用者の発言: 「猫の絵作って」");
		expect(m[1]!.content).toContain("直前のあなたの返事: 「承りました。」");
		expect(lastLines([])).toEqual([]);
	});
	test("a harness that leaves the exchanges and notices out draws them out of the recent conversation", () => {
		const bare = {
			...localHarness,
			history: { ...localHarness.history, toolExchanges: false },
		};
		expect(compose("current", bare).some((x) => x.role === "tool")).toBe(false);
		expect(cloudHarness.history.toolExchanges).toBe(true);
	});
	test("the agent's utterance that copies the system part is not drawn", () => {
		const rule = system
			.split("\n")
			.find((l) => l.startsWith("- 返事は利用者の言語で"))!
			.slice(2);
		const m = composeInput({
			form: "current",
			harness: localHarness,
			system,
			log: [
				...log,
				{ role: "user", text: "もう一度" },
				{ role: "agent", text: rule },
			],
			works: [],
			presented: null,
			say: "x",
		});
		expect(
			m
				.slice(1)
				.map((x) => x.content)
				.join("\n"),
		).not.toContain(rule);
		expect(m.at(-2)!.content).not.toBe(rule);
	});
});

describe("workLines", () => {
	test("works and the presented item in the State's own format", () => {
		expect(
			workLines(
				[
					{
						ref: 2,
						title: "犬の絵",
						state: "reported",
						made: { ref: "a1", label: "犬" },
					},
				],
				"a1",
			),
		).toEqual([
			"仕事:",
			"- t2 犬の絵 報告済み a1「犬」",
			"提示中:",
			"- a1（直前の返事で示した）",
		]);
		expect(workLines([], null)).toEqual([]);
	});
});

describe("saved source", () => {
	test("persona and agency fields come from the stored document; an unknown persona is refused", () => {
		const doc = JSON.stringify({
			general: { agentName: "A", userName: "B", persona: "maid" },
			agency: { interests: ["x", 1], emotion: true },
		});
		expect(systemFieldsOf(doc)).toEqual({
			persona: { agentName: "A", userName: "B", persona: "maid" },
			interests: ["x"],
			emotion: true,
		});
		expect(() =>
			systemFieldsOf(JSON.stringify({ general: { persona: "x" } })),
		).toThrow("harness_saved_persona_unreadable");
	});
	test("titles by id, once each; a card from a definition", () => {
		const row = (id: string, title: string) => ({
			id,
			definition: JSON.stringify({ title, summary: "s", useWhen: ["u", 2] }),
		});
		expect(titlesOf([row("b", "B"), row("a", "A"), row("c", "B")])).toEqual([
			"A",
			"B",
		]);
		expect(cardOf(row("a", "A"))).toEqual({
			id: "a",
			title: "A",
			summary: "s",
			useWhen: ["u"],
		});
	});
});

describe("stream metrics", () => {
	const fresh = (): CallMetrics => ({
		startedAt: 0,
		firstContentMs: null,
		model: null,
		reasoningChars: 0,
		firstTokenMs: null,
		firstTextMs: null,
		totalMs: 0,
		outputTokens: 0,
		tokensFrom: "chunks",
		promptTokens: null,
		cachedPromptTokens: null,
		requestedLimit: 4096,
		finishReason: null,
		tokensPerSecond: null,
	});
	const data = (value: unknown) => `data: ${JSON.stringify(value)}`;
	test("reasoning, first token, first text, usage with cached tokens and the finish reason", () => {
		const m = fresh();
		const state = { chunks: 0, usageOut: null as number | null };
		readStreamLine(
			m,
			data({
				model: "served",
				choices: [{ delta: { reasoning_content: "考え" } }],
			}),
			100,
			state,
		);
		readStreamLine(
			m,
			data({ choices: [{ delta: { content: "はい" } }] }),
			300,
			state,
		);
		readStreamLine(
			m,
			data({
				choices: [{ delta: {}, finish_reason: "stop" }],
				usage: {
					completion_tokens: 21,
					prompt_tokens: 900,
					prompt_tokens_details: { cached_tokens: 800 },
				},
			}),
			400,
			state,
		);
		readStreamLine(m, "data: [DONE]", 410, state);
		readStreamLine(m, "data: {broken", 410, state);
		m.totalMs = 1100;
		finishMetrics(m, state);
		expect(m).toMatchObject({
			model: "served",
			reasoningChars: 2,
			firstTokenMs: 100,
			firstTextMs: 300,
			firstContentMs: 300,
			promptTokens: 900,
			cachedPromptTokens: 800,
			finishReason: "stop",
			outputTokens: 21,
			tokensFrom: "usage",
		});
		expect(m.tokensPerSecond).toBe(20);
	});
	test("without usage the chunks count as tokens", () => {
		const m = fresh();
		const state = { chunks: 0, usageOut: null as number | null };
		readStreamLine(
			m,
			data({ choices: [{ delta: { content: "あ" } }] }),
			10,
			state,
		);
		readStreamLine(
			m,
			data({ choices: [{ delta: { content: "い" } }] }),
			20,
			state,
		);
		m.totalMs = 1010;
		finishMetrics(m, state);
		expect(m.tokensFrom).toBe("chunks");
		expect(m.outputTokens).toBe(2);
	});
});

describe("timing and aggregation", () => {
	const call = (over: Partial<CallMetrics>): CallMetrics => ({
		startedAt: 1000,
		firstContentMs: null,
		model: "served",
		reasoningChars: 100,
		firstTokenMs: 50,
		firstTextMs: 80,
		totalMs: 900,
		outputTokens: 30,
		tokensFrom: "usage",
		promptTokens: 1000,
		cachedPromptTokens: 900,
		requestedLimit: 4096,
		finishReason: "stop",
		tokensPerSecond: 40,
		...over,
	});
	const one = (
		over: Partial<CallMetrics>,
		kind: CallKind = "single",
	): TaggedCall => ({
		kind,
		metrics: call(over),
	});
	test("the user first hears the reply's text, or the hand-over call's end", () => {
		const spoken = timingOf(
			[
				one({ firstContentMs: 400 }),
				one({ startedAt: 3000, firstContentMs: 100 }),
			],
			1000,
			4000,
			false,
		);
		expect(spoken.heardMs).toBe(400);
		const handed = timingOf(
			[one({}), one({ startedAt: 2000, totalMs: 700 })],
			1000,
			2000,
			true,
		);
		expect(handed.heardMs).toBe(1700);
		expect(handed).toMatchObject({
			calls: 2,
			reasoningChars: 200,
			outputTokens: 60,
			cachedPromptTokens: 900,
			requestedLimit: 4096,
			truncated: false,
		});
		expect(
			timingOf([one({ finishReason: "length" })], 1000, 1000, false).truncated,
		).toBe(true);
		expect(timingOf([], 0, 5, false).heardMs).toBeNull();
	});
	const record = (over: Partial<StepRecord>): StepRecord => ({
		...timingOf([one({ firstContentMs: 500 })], 1000, 2000, false),
		chain: "続けて頼む",
		form: "current",
		rep: 0,
		index: 0,
		say: "s",
		scored: true,
		pass: true,
		why: "",
		said: "",
		turnMode: "single",
		failedCheck: null,
		failedChecks: [],
		cloudAnswered: false,
		copyRun: null,
		stop: "answer",
		callDetails: [],
		...over,
	});
	test("free steps are not counted; the cell sums passes, means timings, and shares cache", () => {
		const cell = cellOf([
			record({}),
			record({ pass: false, why: "呼ばずに返事" }),
			record({ scored: false }),
		]);
		expect(cell).toMatchObject({
			passed: 1,
			total: 2,
			heardMs: 500,
			truncated: 0,
			cachedShare: 0.9,
		});
		expect(cell.fails).toEqual([
			"続けて頼む / current / 回1 / s: 呼ばずに返事",
		]);
		expect(cellOf([]).heardMs).toBeNull();
	});
	test("the Markdown has the chain x form scores, the totals and the failures", () => {
		const meta = {
			startedAt: "2026-10-28T00:00:00.000Z",
			client: "larm",
			harness: "local",
			reasoning: "medium",
			outputLimit: 4096,
			reps: 1,
			probe: false,
			turn: "single" as const,
			fallback: "-",
			chains: ["続けて頼む", "話の続き"],
			forms: ["current", "empty"],
			settings: null,
		};
		const md = reportMarkdown(meta, [
			record({}),
			record({ form: "empty", pass: false, why: "呼ばずに返事" }),
			record({ chain: "話の続き" }),
		]);
		expect(md).toContain("| 続けて頼む | 1/1 | 0/1 |");
		expect(md).toContain("| 話の続き | 1/1 | - |");
		expect(md).toContain("| 合計 | 2/2 | 0/1 |");
		expect(md).toContain("- 続けて頼む / empty / 回1 / s: 呼ばずに返事");
		expect(md).toContain(
			"| 出力の上限（ハーネス / 実際に求めた値） | 4096 / 4096 |",
		);
	});
});

describe("options and plan", () => {
	test("defaults: the local harness on the saved LARM connection, today's form, every chain, one rep", () => {
		const o = parseOptions([]);
		expect(o).toMatchObject({
			client: "larm",
			reps: 1,
			probe: false,
			dryRun: false,
			reasoning: "medium",
			reasoningOverridden: false,
		});
		expect(o.harness.name).toBe("local");
		expect(o.forms).toEqual(["current"]);
		expect(o.chains).toHaveLength(9);
	});
	test("the Codex path takes the cloud harness and needs a model; off is not available there", () => {
		expect(() => parseOptions(["--client", "codex"])).toThrow("--model");
		const o = parseOptions(["--client", "codex", "--model", "m"]);
		expect(o).toMatchObject({ model: "m", reasoning: "low" });
		expect(o.harness.name).toBe("cloud");
		expect(() =>
			parseOptions(["--client", "codex", "--model", "m", "--reasoning", "off"]),
		).toThrow("not available");
		expect(parseOptions(["--client", "codex", "--dry-run"]).dryRun).toBe(true);
	});
	test("a reasoning override, chain and form selection, and bad values", () => {
		const o = parseOptions([
			"--reasoning",
			"low",
			"--chains",
			"topic,broken",
			"--forms",
			"empty,empty-last",
			"--reps",
			"2",
		]);
		expect(o).toMatchObject({
			reasoning: "low",
			reasoningOverridden: true,
			reps: 2,
		});
		expect(o.chains.map((c) => c.key)).toEqual(["topic", "broken"]);
		expect(o.forms).toEqual(["empty", "empty-last"]);
		expect(() => parseOptions(["--chains", "nope"])).toThrow("unknown chain");
		expect(() => parseOptions(["--forms", "nope"])).toThrow("unknown form");
		expect(() => parseOptions(["--reps", "0"])).toThrow("--reps");
		expect(() => parseOptions(["--bogus"])).toThrow("unknown option");
		expect(() => parseOptions(["--reasoning"])).toThrow("needs a value");
	});
	test("--probe is six tries of the first request in the empty form", () => {
		const o = parseOptions(["--probe"]);
		expect(o.reps).toBe(6);
		expect(o.forms).toEqual(["empty"]);
		expect(o.chains).toHaveLength(1);
		expect(o.chains[0]!.steps).toHaveLength(1);
	});
	test("runs interleave rep, chain, form", () => {
		const o = parseOptions([
			"--chains",
			"topic,reword",
			"--forms",
			"current,empty",
			"--reps",
			"2",
		]);
		expect(planOf(o).map((p) => `${p.rep}:${p.chain.key}:${p.form}`)).toEqual([
			"0:topic:current",
			"0:topic:empty",
			"0:reword:current",
			"0:reword:empty",
			"1:topic:current",
			"1:topic:empty",
			"1:reword:current",
			"1:reword:empty",
		]);
	});
});
