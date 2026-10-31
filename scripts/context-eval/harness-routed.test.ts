import { describe, expect, test } from "bun:test";
import { localHarness } from "../../api/domains/dialogue/service/harness";
import { INPUT_HEADINGS } from "../../api/domains/dialogue/service/input-text";
import { parseCall } from "../../api/domains/dialogue/service/generation-tools";
import { ValidationFailure } from "../../api/infrastructure/validation-log";
import { CARD_IDS, CHAINS, type Card } from "./harness-chains";
import type { TurnEnv } from "./harness-calls";
import {
	createMetricsFetch,
	type CallMetrics,
	type CallSettings,
	type ModelClient,
} from "./harness-client";
import {
	buildSystem,
	composeInput,
	routedInputOf,
	type Entry,
} from "./harness-compose";
import {
	arrived,
	cut,
	detailLines,
	errorCodeOf,
	issuesOf,
	newDetail,
} from "./harness-detail";
import {
	cacheSection,
	cellOf,
	copyRunOf,
	failureDetails,
	reportMarkdown,
	stopCounts,
	timingOf,
	tokensOf,
	type StepRecord,
} from "./harness-judge";
import { dryRunText, parseOptions, startLog } from "./harness";
import { runRoutedTurn, type RequestInput } from "./harness-routed";

const cards = Object.fromEntries(
	CARD_IDS.map((id): [string, Card] => [
		id,
		{ id, title: id, summary: "s", useWhen: [] },
	]),
);
const settings: CallSettings = { reasoning: "medium", outputLimit: 4096 };
const metric = (over: Partial<CallMetrics> = {}): CallMetrics => ({
	startedAt: 0,
	firstContentMs: null,
	model: "served",
	reasoningChars: 0,
	firstTokenMs: 10,
	firstTextMs: 20,
	totalMs: 100,
	outputTokens: 5,
	tokensFrom: "usage",
	promptTokens: 100,
	cachedPromptTokens: 90,
	requestedLimit: 4096,
	finishReason: "stop",
	tokensPerSecond: 50,
	...over,
});

type Reply = {
	chunks: string[];
	/** The stream breaks with this error after its chunks. */
	error?: string;
};
/** A scripted model: the streamed replies and the choices it gives in order, and what each call was sent. */
function fakeClient(script: { replies?: Reply[]; choices?: string[] }) {
	const replies = [...(script.replies ?? [])];
	const choices = [...(script.choices ?? [])];
	const delivered: string[][] = [];
	let talks = 0;
	const chosen: Array<{
		messages: readonly { role: string; content: string }[];
		schema: Record<string, unknown>;
	}> = [];
	let made = 0;
	const client: ModelClient = {
		async connect() {},
		async close() {},
		async take() {
			const n = made;
			made = 0;
			return Array.from({ length: n }, () => metric());
		},
		async talk(_messages, _settings, _signal, onDelta) {
			made++;
			talks++;
			const reply = replies.shift()!;
			const seen: string[] = [];
			delivered.push(seen);
			for (const chunk of reply.chunks) {
				seen.push(chunk);
				onDelta(chunk);
			}
			if (reply.error) throw new Error(reply.error);
			return reply.chunks.join("");
		},
		async decide(messages, _settings, _signal, schema) {
			made++;
			chosen.push({ messages, schema });
			return choices.shift()!;
		},
	};
	return { client, delivered, talks: () => talks, chosen };
}

const system = buildSystem({
	persona: { agentName: "", userName: "", persona: "butler" },
	interests: [],
	emotion: false,
});
const input = (say: string, chain = "sequence") =>
	composeInput({
		form: "current",
		harness: localHarness,
		system,
		log: startLog(CHAINS.find((c) => c.key === chain)!),
		say,
	});
const env = (client: ModelClient, over: Partial<TurnEnv> = {}): TurnEnv => ({
	client,
	settings,
	...over,
});
const kinds = (r: { calls: Array<{ kind: string }> }) =>
	r.calls.map((c) => c.kind);
const json = (value: unknown) => JSON.stringify(value);

/** The request turn's input for a step of a chain, over an empty talk (or the log given). */
const requestOf = (
	utterance: string,
	log: Entry[] = startLog(CHAINS[0]!),
	works: Parameters<typeof routedInputOf>[0]["works"] = [],
): RequestInput => ({
	routed: routedInputOf({ log, works, presented: null }),
	utterance,
	style: "丁寧に話す",
});

const record = (over: Partial<StepRecord>): StepRecord => ({
	...timingOf(
		[{ kind: "talk", metrics: metric({ firstContentMs: 500 }) }],
		0,
		1000,
		false,
	),
	chain: "続けて頼む",
	form: "current",
	rep: 0,
	index: 0,
	say: "s",
	scored: true,
	pass: true,
	why: "",
	said: "",
	copyRun: 3,
	stop: "answer",
	callTokens: [],
	callDetails: [],
	...over,
});

describe("runRoutedTurn, the request turn", () => {
	const handOver = json({
		choice: "image.create",
		say: "猫の絵を描きます。",
		request: "猫の絵",
	});
	test("a candidate is handed over with its say; one silent choice call is made on the product's input and schema", async () => {
		const fake = fakeClient({ choices: [handOver] });
		const r = await runRoutedTurn(
			env(fake.client),
			input("猫の絵作って"),
			cards,
			1,
			requestOf("猫の絵作って"),
		);
		expect(r.delegated).toEqual({
			toolchain: "image.create",
			request: "猫の絵",
		});
		expect(r.said).toBe("猫の絵を描きます。");
		expect(r).toMatchObject({ stop: "handover", hostSpoke: true, acted: true });
		expect(kinds(r)).toEqual(["choice"]);
		expect(r.toolCalls.map((c) => c.name)).toEqual([
			"find_toolchain",
			"delegate",
		]);
		expect(JSON.parse(r.toolCalls[1]!.result)).toEqual({ todo: "t1" });
		expect(fake.talks()).toBe(0);
		const [sent] = fake.chosen;
		const last = sent!.messages.at(-1)!.content;
		expect(sent!.messages[0]!.role).toBe("system");
		expect(last).toContain(INPUT_HEADINGS.candidates);
		expect(last).toContain("image.create");
		expect(last).toContain("猫の絵作って");
		expect(last).not.toContain(INPUT_HEADINGS.retry);
		expect(JSON.stringify(sent!.schema)).toContain('"image.create"');
		expect(r.details[0]).toMatchObject({
			kind: "choice",
			choiceJson: handOver,
		});
		expect(r.details[0]!.toolCalls[0]).toMatchObject({
			name: "image.create",
			verdict: "accepted",
			outcome: "引き渡し image.create",
		});
	});
	test("none goes on to the talk turn: a streamed call that offers no tools, heard at its first text", async () => {
		const fake = fakeClient({
			choices: [json({ choice: "none" })],
			replies: [{ chunks: ["どういたしまして。"] }],
		});
		const r = await runRoutedTurn(
			env(fake.client),
			input("ありがとう"),
			cards,
			1,
			requestOf("ありがとう"),
		);
		expect(kinds(r)).toEqual(["choice", "talk"]);
		expect(r).toMatchObject({
			said: "どういたしまして。",
			stop: "answer",
			hostSpoke: false,
		});
		expect(r.delegated).toBeUndefined();
		expect(fake.talks()).toBe(1);
		expect(r.details[0]!.toolCalls[0]).toMatchObject({ outcome: "会話の回へ" });
	});
	test("a step the judge sends to talk makes the one talk call and no choice", async () => {
		const fake = fakeClient({ replies: [{ chunks: ["はい。"] }] });
		const r = await runRoutedTurn(
			env(fake.client),
			input("ありがとう"),
			cards,
			1,
			null,
		);
		expect(kinds(r)).toEqual(["talk"]);
		expect(r).toMatchObject({ said: "はい。", acted: false, stop: "answer" });
		expect(fake.chosen).toEqual([]);
		expect(fake.talks()).toBe(1);
		expect(r.toolCalls).toEqual([]);
	});
	test("the talk call stops when it copies the system part", async () => {
		const rule = system
			.split("\n")
			.find((l) => l.startsWith("- 返事は利用者の言語で"))!
			.slice(2);
		const { systemCopyCheck } =
			await import("../../api/domains/dialogue/service/conversation-output");
		const fake = fakeClient({ replies: [{ chunks: [rule, "続き。"] }] });
		const r = await runRoutedTurn(
			env(fake.client, { copies: systemCopyCheck(system) }),
			input("やあ"),
			cards,
			1,
			null,
		);
		expect(r.stop).toBe("error");
		expect(r.error).toBe("system_text_copied");
		expect(fake.delivered[0]).toEqual([rule]);
	});
	test("ask says the question and carries the ask step; the next turn takes the answer with the request", async () => {
		const fake = fakeClient({
			choices: [json({ choice: "ask", say: "何の絵にしましょうか？" })],
		});
		const r = await runRoutedTurn(
			env(fake.client),
			input("絵を描いて"),
			cards,
			1,
			requestOf("絵を描いて"),
		);
		expect(r).toMatchObject({
			said: "何の絵にしましょうか？",
			stop: "ask",
			hostSpoke: true,
		});
		expect(r.toolCalls.map((c) => c.name)).toEqual(["find_toolchain", "ask"]);
		const log: Entry[] = [
			{ role: "user", text: "絵を描いて" },
			{ role: "agent", text: r.said, toolCalls: r.toolCalls },
		];
		expect(routedInputOf({ log, works: [], presented: null }).asked).toEqual({
			request: "絵を描いて",
		});
	});
	test("an answer to a question back is searched with the asked request and the answer together", async () => {
		const log = startLog(CHAINS.find((c) => c.key === "answer-picture")!);
		const asked = requestOf("猫で", log);
		expect(asked.routed.asked).toEqual({ request: "絵を描いて" });
		const withAsk = fakeClient({
			choices: [
				json({ choice: "image.create", say: "描きます。", request: "猫の絵" }),
			],
		});
		await runRoutedTurn(env(withAsk.client), input("猫で"), cards, 1, asked);
		const shown = withAsk.chosen[0]!.messages.at(-1)!.content;
		expect(shown).toContain("model3d.studio");
		expect(shown).toContain("聞き返した依頼: 絵を描いて");
		// Without the question the words alone find the general candidates.
		const alone = fakeClient({
			choices: [json({ choice: "none" })],
			replies: [{ chunks: ["はい。"] }],
		});
		await runRoutedTurn(
			env(alone.client),
			input("猫で"),
			cards,
			1,
			requestOf("猫で"),
		);
		expect(alone.chosen[0]!.messages.at(-1)!.content).not.toContain(
			"model3d.studio",
		);
	});
	test("a work candidate without its request is not taken; a todo not shown is not offered", async () => {
		const noRequest = fakeClient({
			choices: [
				json({ choice: "image.create", say: "描きます。", request: " " }),
				handOver,
			],
		});
		const r = await runRoutedTurn(
			env(noRequest.client),
			input("猫の絵作って"),
			cards,
			1,
			requestOf("猫の絵作って"),
		);
		expect(r.details[0]!.check).toBe("request_required");
		expect(r.stop).toBe("handover");
		const stray = fakeClient({
			choices: [
				json({ choice: "t9", operation: "cancel", say: "止めます。" }),
				json({ choice: "t1", operation: "cancel", say: "止めます。" }),
			],
		});
		const cancelled = await runRoutedTurn(
			env(stray.client),
			input("やめて"),
			cards,
			2,
			requestOf("やめて", undefined, [
				{ ref: 1, title: "猫の絵", state: "running" },
			]),
		);
		expect(cancelled.details[0]!.check).toBe("choice_not_offered");
		expect(cancelled).toMatchObject({ said: "止めます。", stop: "answer" });
		expect(cancelled.delegated).toBeUndefined();
		expect(JSON.stringify(stray.chosen[1]!.schema)).toContain('"t1"');
	});
});

describe("the talk input and the choice input of a routed harness", () => {
	test("the talk turn's State is the today line alone; the works go to the choice input", () => {
		const works = [{ ref: 1, title: "猫の絵", state: "running" as const }];
		const talk = composeInput({
			form: "current",
			harness: localHarness,
			system,
			log: startLog(CHAINS[0]!),
			say: "まだかな",
		});
		expect(talk.at(-1)!.content).toBe(
			"## State\n今: 10-28（水）10:00\n\n## User\nまだかな",
		);
		const routed = routedInputOf({
			log: [
				{ role: "user", text: "猫の絵作って" },
				{ role: "agent", text: "承りました。" },
			],
			works,
			presented: null,
		});
		expect(routed).toEqual({
			memory: null,
			earlier: ["猫の絵作って"],
			state: "## State\n今: 10-28（水）10:00\n仕事:\n- t1 猫の絵 実行中",
			previousReply: "承りました。",
			asked: null,
			pending: { confirmations: [], questions: [] },
			todos: [{ ref: 1, title: "猫の絵", open: true }],
			resources: [],
			switching: null,
		});
	});
	test("the previous reply is cut to 200 characters; a reported work may only be checked", () => {
		const routed = routedInputOf({
			log: [{ role: "agent", text: "あ".repeat(300) }],
			works: [
				{ ref: 1, title: "a", state: "running" },
				{ ref: 2, title: "b", state: "reported" },
			],
			presented: null,
		});
		expect(routed.previousReply).toHaveLength(200);
		expect(routed.todos).toEqual([
			{ ref: 1, title: "a", open: true },
			{ ref: 2, title: "b", open: false },
		]);
	});
});

describe("timing and metrics", () => {
	const tagged = (kind: "choice" | "talk", over: Partial<CallMetrics>) => ({
		kind,
		metrics: metric(over),
	});
	test("a choice is never heard; a talk call is heard at its first text", () => {
		const t = timingOf(
			[
				tagged("choice", {
					startedAt: 1000,
					totalMs: 800,
					firstTokenMs: 30,
					firstTextMs: 40,
					firstContentMs: 40,
				}),
				tagged("talk", {
					startedAt: 1800,
					totalMs: 600,
					firstTokenMs: 50,
					firstTextMs: 60,
					firstContentMs: 60,
				}),
			],
			1000,
			1400,
			false,
		);
		expect(t.heardMs).toBe(860);
		expect(t).toMatchObject({
			calls: 2,
			choiceFirstTokenMs: 30,
			choiceFirstTextMs: 40,
			choiceMs: 800,
			talkFirstTokenMs: 50,
			talkFirstTextMs: 60,
			talkMs: 600,
		});
	});
	test("words the host says are heard at the end of the last call", () => {
		const spoke = timingOf(
			[
				tagged("choice", {
					startedAt: 1000,
					totalMs: 500,
					firstContentMs: 10,
				}),
			],
			1000,
			500,
			true,
		);
		expect(spoke.heardMs).toBe(500);
		expect(spoke.talkMs).toBeNull();
		expect(timingOf([], 0, 5, false).heardMs).toBeNull();
	});
	test("the longest run shared with the previous reply, spaces left out", () => {
		expect(
			copyRunOf(
				"おすすめは 雨に唄えば です",
				"先ほどのおすすめは雨に唄えばですよ",
			),
		).toBe("おすすめは雨に唄えばです".length);
		expect(copyRunOf("あ", "")).toBeNull();
		expect(copyRunOf("", "あ")).toBeNull();
		expect(copyRunOf("abc", "xyz")).toBe(0);
	});
	const choiceDetail = () => newDetail("choice");
	test("a cell has the calls per step, the retry share of the steps that chose and the share of replies copying 20+ characters", () => {
		const cell = cellOf([
			record({ callDetails: [choiceDetail()] }),
			record({
				callDetails: [choiceDetail(), choiceDetail()],
				copyRun: null,
			}),
			record({ copyRun: 25 }),
			record({ copyRun: 20, scored: false }),
		]);
		expect(cell.retryShare).toBe(0.5);
		expect(cell.calls).toBe(1);
		// Three replies were measured, and two of them share 20 characters or more.
		expect(cell.copyShare).toBeCloseTo(2 / 3);
		expect(cellOf([record({})]).retryShare).toBeNull();
		expect(cellOf([record({ copyRun: null })]).copyShare).toBeNull();
	});
	test("the Markdown carries the columns, the routed phase timings and how the turns ended", () => {
		const md = reportMarkdown(
			{
				startedAt: "2026-10-28T00:00:00.000Z",
				reasoning: "off",
				outputLimit: 512,
				reps: 1,
				probe: false,
				chains: ["続けて頼む"],
				forms: ["current"],
				settings: "sha256:x",
			},
			[
				record({ callDetails: [choiceDetail()] }),
				record({
					stop: "check",
					pass: false,
					why: "choice:choice_unreadable",
					callDetails: [choiceDetail(), choiceDetail()],
				}),
			],
		);
		expect(md).toContain("呼出し数 |");
		expect(md).toContain("選び直し率 | 前の返事の写し(20字以上)");
		expect(md).toContain("| 50% | 0% |");
		expect(md).toContain("## 選ぶ呼出しと話す呼出しの時間");
		expect(md).toContain("- check: 1");
		expect(stopCounts([])).toEqual(["なし"]);
	});
});

describe("options and dry run for the turn", () => {
	const source = {
		persona: { agentName: "", userName: "", persona: "butler" as const },
		interests: [],
		emotion: false,
	};
	test("--turn names the routed turn, the only one; the options of the removed turn and paths are unknown", () => {
		expect(() => parseOptions([])).not.toThrow();
		expect(() => parseOptions(["--turn", "routed"])).not.toThrow();
		expect(() => parseOptions(["--turn", "single"])).toThrow(
			"--turn is routed",
		);
		expect(() => parseOptions(["--turn", "decide-then-reply"])).toThrow(
			"--turn is routed",
		);
		for (const removed of [
			["--harness", "cloud"],
			["--client", "codex"],
			["--model", "m"],
			["--fallback-client", "codex"],
		])
			expect(() => parseOptions(removed)).toThrow("unknown option");
	});
	test("the dry run of a local harness prints the talk system, the talk messages, and the choice messages and schema", () => {
		const text = dryRunText(
			parseOptions(["--chains", "answer-picture", "--dry-run"]),
			{ source, cards },
		);
		expect(text).toContain("turn: routed");
		expect(text).toContain("=== system of the talk turn");
		expect(text).toContain("=== answer-picture / current: ");
		expect(text).toContain("(the talk turn)");
		expect(text).toContain("the choice call of the first step");
		expect(text).toMatch(/schema: \d+ chars, ~\d+ tokens/);
		expect(text).toContain("schema (as sent): {");
		expect(text).toContain("## Candidates");
		expect(text).toContain("聞き返した依頼: 絵を描いて");
		expect(text).not.toContain("## Functions");
	});
});

describe("the metrics fetch and the clients", () => {
	test("a call the reader stops ends its timing there, without a finish reason from the server", async () => {
		const original = globalThis.fetch;
		const data = new TextEncoder().encode(
			'data: {"model":"served","choices":[{"delta":{"content":"あ"}}]}\n',
		);
		// A stream the server never ends: only the reader's stop can finish the call.
		globalThis.fetch = (async () =>
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(data);
					},
				}),
			)) as unknown as typeof fetch;
		try {
			const timed = createMetricsFetch();
			const res = await timed.fetch("http://x/chat/completions", {
				method: "POST",
				body: JSON.stringify({ stream: true, max_tokens: 4096 }),
			});
			const reader = res.body!.getReader();
			await reader.read();
			await reader.cancel();
			const [m] = await timed.take();
			expect(m).toMatchObject({
				model: "served",
				finishReason: "stopped",
				requestedLimit: 4096,
				firstContentMs: expect.any(Number),
			});
			expect(m!.totalMs).toBeGreaterThan(0);
		} finally {
			globalThis.fetch = original;
		}
	});
});

describe("the record of each model call", () => {
	test("the helpers: cut, error code, what arrived, issues of a refused call", () => {
		expect(cut("abcdef", 3)).toBe("abc…");
		expect(cut("abc", 3)).toBe("abc");
		expect(errorCodeOf(Object.assign(new Error("m"), { code: "c1" }))).toBe(
			"c1",
		);
		expect(errorCodeOf(new Error("chat_stream_incomplete"))).toBe(
			"chat_stream_incomplete",
		);
		const detail = newDetail("talk");
		arrived(detail, "こんにちは");
		arrived(detail, "。");
		expect(detail).toMatchObject({ text: "こんにちは。", textChars: 6 });
		let failure: unknown;
		try {
			parseCall({
				id: "i",
				name: "delegate",
				arguments: json({ mode: "execute", request: "猫の絵" }),
			});
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(ValidationFailure);
		expect(issuesOf(failure as ValidationFailure)[0]).toMatchObject({
			code: expect.any(String),
			path: expect.stringContaining("toolchain"),
		});
	});
	test("the details section lists a failed routed step's calls with the choice and the reason it was not taken", async () => {
		const fake = fakeClient({
			choices: [json({ choice: "nope" }), json({ choice: "nope" })],
		});
		const r = await runRoutedTurn(
			env(fake.client),
			input("x"),
			cards,
			1,
			requestOf("x"),
		);
		const failed = record({
			...timingOf(r.calls, 0, 100, r.hostSpoke),
			say: "猫の絵作って",
			pass: false,
			why: "choice:choice_not_offered",
			stop: r.stop,
			callTokens: tokensOf(r.calls),
			callDetails: r.details,
		});
		const text = failureDetails([failed]).join("\n");
		expect(text).toContain(
			"続けて頼む / current / 回1 / 猫の絵作って: choice:choice_not_offered（終わり方: check、モデルの呼出し 2 回）",
		);
		expect(text).toContain("1. choice / finish=stop");
		expect(text).toContain("check=choice_not_offered");
		expect(text).toContain('選択: `{"choice":"nope"}`');
		expect(text).toContain(
			'nope `{"choice":"nope"}` → 拒否 choice_not_offered',
		);
		expect(failureDetails([{ ...failed, pass: true }])).toEqual(["なし"]);
		expect(detailLines(r.details[0]!, 1)[0]).toContain("1. choice");
	});
	test("the step record carries the details as JSON", async () => {
		const r = await runRoutedTurn(
			env(
				fakeClient({
					choices: [json({ choice: "none" })],
					replies: [{ chunks: ["はい。"] }],
				}).client,
			),
			input("ありがとう"),
			cards,
			1,
			requestOf("ありがとう"),
		);
		const roundTrip = JSON.parse(JSON.stringify(r.details));
		expect(roundTrip.map((d: { kind: string }) => d.kind)).toEqual([
			"choice",
			"talk",
		]);
		expect(roundTrip[1]).toMatchObject({
			text: "はい。",
			textChars: 3,
			toolCalls: [],
		});
	});
});

describe("the cache figures", () => {
	test("the cached share counts every call, not only the first", () => {
		const cell = cellOf([
			record({
				callTokens: [
					{ kind: "talk", promptTokens: 1000, cachedPromptTokens: 0 },
					{ kind: "talk", promptTokens: 1000, cachedPromptTokens: 1000 },
				],
			}),
			record({
				callTokens: [
					{ kind: "talk", promptTokens: null, cachedPromptTokens: null },
				],
			}),
		]);
		expect(cell.cachedShareAll).toBe(0.5);
		expect(cellOf([record({})]).cachedShareAll).toBeNull();
	});
	test("every run lists its calls with form and round, in the report", () => {
		const rows = [
			record({
				index: 0,
				callTokens: [
					{ kind: "talk", promptTokens: 3800, cachedPromptTokens: 0 },
				],
			}),
			record({
				form: "empty",
				index: 1,
				callTokens: [
					{ kind: "choice", promptTokens: 3900, cachedPromptTokens: 3700 },
					{ kind: "talk", promptTokens: 3900, cachedPromptTokens: 3800 },
				],
			}),
		];
		const lines = cacheSection(rows);
		expect(lines[0]).toBe("## キャッシュ（呼出しごと）");
		expect(lines).toContain(
			"| 続けて頼む | current | 1 | 1 | 1 | talk | 3800 | 0 | 0% |",
		);
		expect(lines).toContain(
			"| 続けて頼む | empty | 1 | 2 | 2 | talk | 3900 | 3800 | 97% |",
		);
		expect(cacheSection([record({})])).toEqual([]);
		const md = reportMarkdown(
			{
				startedAt: "t",
				reasoning: "medium",
				outputLimit: 4096,
				reps: 1,
				probe: false,
				chains: ["続けて頼む"],
				forms: ["current", "empty"],
				settings: "sha256:x",
			},
			rows,
		);
		expect(md).toContain("cache(全呼出し)");
		expect(md).toContain("## キャッシュ（呼出しごと）");
	});
});
