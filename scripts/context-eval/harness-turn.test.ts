import { describe, expect, test } from "bun:test";
import type { NativeToolCall } from "../../api/infrastructure/chat-stream";
import { localHarness } from "../../api/domains/dialogue/service/harness";
import { CARD_IDS, CHAINS, type Card } from "./harness-chains";
import {
	createMetricsFetch,
	type CallMetrics,
	type CallSettings,
	type ModelClient,
} from "./harness-client";
import { buildSystem, composeInput } from "./harness-compose";
import {
	cacheSection,
	cellOf,
	checkCounts,
	copyRunOf,
	judgeStep,
	reportMarkdown,
	timingOf,
	type StepRecord,
} from "./harness-judge";
import {
	cut,
	decisionCall,
	detailLines,
	errorCodeOf,
	issuesOf,
} from "./harness-detail";
import { ValidationFailure } from "../../api/infrastructure/validation-log";
import { parseCall } from "../../api/domains/dialogue/service/generation-tools";
import { failureDetails, tokensOf } from "./harness-judge";
import { decisionNotes, dryRunText, parseOptions, startLog } from "./harness";
import { runTurn, type TurnEnv } from "./harness-turn";

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
	toolCalls?: NativeToolCall[];
	/** The stream breaks with this error after its chunks. */
	error?: string;
};
/** A scripted model: the decisions and the streamed replies it gives in order, and the chunks each reply delivered. */
function fakeClient(script: { decisions?: string[]; replies?: Reply[] }) {
	const decisions = [...(script.decisions ?? [])];
	const replies = [...(script.replies ?? [])];
	const delivered: string[][] = [];
	const decided: Array<readonly { role: string; content: string }[]> = [];
	let made = 0;
	const client: ModelClient = {
		async connect() {},
		async close() {},
		async take() {
			const n = made;
			made = 0;
			return Array.from({ length: n }, () => metric());
		},
		async stream(_messages, _settings, _signal, onDelta) {
			made++;
			const reply = replies.shift()!;
			const seen: string[] = [];
			delivered.push(seen);
			for (const chunk of reply.chunks) {
				seen.push(chunk);
				onDelta(chunk);
			}
			if (reply.error) throw new Error(reply.error);
			return { text: reply.chunks.join(""), toolCalls: reply.toolCalls ?? [] };
		},
		async decide(messages) {
			made++;
			decided.push(messages);
			return decisions.shift()!;
		},
	};
	return { client, delivered, decided };
}

const call = (name: string, args: unknown) =>
	JSON.stringify({ action: "call", tool: { name, arguments: args } });
const REPLY = JSON.stringify({ action: "reply", tool: null });
const system = buildSystem(
	{
		persona: { agentName: "", userName: "", persona: "butler" },
		interests: [],
		emotion: false,
		titles: [],
	},
	localHarness,
);
const input = (say: string, chain = "sequence") =>
	composeInput({
		form: "current",
		harness: localHarness,
		system,
		log: startLog(CHAINS.find((c) => c.key === chain)!),
		works: [],
		presented: null,
		say,
	});
const env = (client: ModelClient, over: Partial<TurnEnv> = {}): TurnEnv => ({
	client,
	settings,
	mode: "decide-then-reply",
	cloud: null,
	...over,
});
const kinds = (r: { calls: Array<{ kind: string }> }) =>
	r.calls.map((c) => c.kind);

describe("runTurn, decide-then-reply", () => {
	test("a reply whose head passes is published; the calls are filed as decision and reply", async () => {
		const { client } = fakeClient({
			decisions: [REPLY],
			replies: [{ chunks: ["どういたしまして。", "また何かあれば。"] }],
		});
		const r = await runTurn(env(client), input("ありがとう"), cards, 1);
		expect(r).toMatchObject({
			said: "どういたしまして。また何かあれば。",
			acted: false,
			cloudAnswered: false,
			failedChecks: [],
		});
		expect(r.publishedAt).not.toBeNull();
		expect(kinds(r)).toEqual(["decision", "reply"]);
	});
	test("a search and a hand-over are decisions run on the simulated host; the hand-over ends the turn", async () => {
		const { client } = fakeClient({
			decisions: [
				call("find_toolchain", { query: "画像 猫" }),
				call("delegate", {
					mode: "execute",
					toolchain: "image.create",
					request: "猫の絵",
					impact: "create",
					announcement: "承りました。",
				}),
			],
		});
		const r = await runTurn(env(client), input("猫の絵作って"), cards, 1);
		expect(r.delegated).toEqual({
			toolchain: "image.create",
			request: "猫の絵",
		});
		expect(r.said).toBe("承りました。");
		expect(kinds(r)).toEqual(["decision", "decision"]);
		expect(r.toolCalls.map((c) => c.name)).toEqual([
			"find_toolchain",
			"delegate",
		]);
		expect(r.publishedAt).toBeNull();
	});
	test("a head that promises without a call stops the reply and fails the step with the check", async () => {
		const { client, delivered } = fakeClient({
			decisions: [REPLY],
			replies: [
				{
					chunks: [
						"猫の絵を",
						"作ります。",
						"少々お待ちください。",
						"ありがとうございます。",
					],
				},
			],
		});
		const r = await runTurn(env(client), input("猫の絵作って"), cards, 1);
		expect(r.localFailure).toBe("promise_without_call");
		expect(r.failedChecks).toEqual(["promise_without_call"]);
		expect(r.said).toBe("");
		// The reply call was stopped at the head: the rest of the stream was not read.
		expect(delivered[0]).toEqual([
			"猫の絵を",
			"作ります。",
			"少々お待ちください。",
		]);
		expect(
			judgeStep({ say: "x", free: true }, r, {
				copies: () => false,
				lastAgent: "",
			}),
		).toEqual({
			pass: false,
			why: "fallback:promise_without_call",
		});
	});
	test("an unreadable decision and an unknown tool are checks too", async () => {
		const garbled = await runTurn(
			env(fakeClient({ decisions: ["not json"] }).client),
			input("x"),
			cards,
			1,
		);
		expect(garbled.failedChecks).toEqual(["decision_unparsed"]);
		const unknown = await runTurn(
			env(fakeClient({ decisions: [call("nope", {})] }).client),
			input("x"),
			cards,
			1,
		);
		expect(unknown.failedChecks).toEqual(["tool_unknown"]);
		const invalid = await runTurn(
			env(
				fakeClient({ decisions: [call("delegate", { mode: "execute" })] })
					.client,
			),
			input("x"),
			cards,
			1,
		);
		expect(invalid.failedChecks).toEqual(["tool_arguments_invalid"]);
	});
	test("after a search with candidates the reply is held to its end and must ask or refuse", async () => {
		const { client } = fakeClient({
			decisions: [call("find_toolchain", { query: "画像" }), REPLY],
			replies: [{ chunks: ["画像生成と3Dモデルがあります。"] }],
		});
		const r = await runTurn(env(client), input("猫の絵作って"), cards, 1);
		expect(r.localFailure).toBe("searched_not_handed");
		const ok = fakeClient({
			decisions: [call("find_toolchain", { query: "画像" }), REPLY],
			replies: [{ chunks: ["どちらで作りますか？"] }],
		});
		const asked = await runTurn(
			env(ok.client),
			input("猫の絵作って"),
			cards,
			1,
		);
		expect(asked.said).toBe("どちらで作りますか？");
		expect(asked.failedChecks).toEqual([]);
	});
	test("a reply that copies the previous reply fails; asking to hear it again does not", async () => {
		const prev = "おすすめの映画は、雨に唄えば、です。";
		const copied = fakeClient({
			decisions: [REPLY],
			replies: [{ chunks: [prev] }],
		});
		const r = await runTurn(
			env(copied.client),
			composeInput({
				form: "current",
				harness: localHarness,
				system,
				log: [
					...startLog(CHAINS.find((c) => c.key === "reword")!),
					{ role: "user", text: "映画を教えて" },
					{ role: "agent", text: prev },
				],
				works: [],
				presented: null,
				say: "ありがとう",
			}),
			cards,
			1,
		);
		expect(r.failedChecks).toEqual(["previous_reply_copied"]);
	});
	test("with a cloud path the failed round is answered there, and its answer is the turn's", async () => {
		// After the cloud's search the next round is local again, and hands the work over.
		const local = fakeClient({
			decisions: [
				REPLY,
				call("delegate", {
					mode: "execute",
					toolchain: "image.create",
					request: "猫の絵",
					impact: "create",
				}),
			],
			replies: [{ chunks: ["猫の絵を作ります。"] }],
		});
		const cloud = fakeClient({
			replies: [
				{
					chunks: [],
					toolCalls: [
						{
							id: "c1",
							name: "find_toolchain",
							arguments: JSON.stringify({ query: "画像 猫" }),
						},
					],
				},
			],
			decisions: [],
		});
		const r = await runTurn(
			env(local.client, { cloud: { client: cloud.client, settings } }),
			input("猫の絵作って"),
			cards,
			1,
		);
		expect(r.cloudAnswered).toBe(true);
		expect(r.failedChecks).toEqual(["promise_without_call"]);
		expect(r.localFailure).toBeUndefined();
		expect(kinds(r)).toEqual(["decision", "reply", "cloud", "decision"]);
		expect(r.delegated?.toolchain).toBe("image.create");
	});
	test("the single turn is one call per round, filed as single", async () => {
		const { client } = fakeClient({
			replies: [{ chunks: ["こんにちは。"] }],
		});
		const r = await runTurn(
			env(client, { mode: "single" }),
			input("やあ"),
			cards,
			1,
		);
		expect(kinds(r)).toEqual(["single"]);
		expect(r.said).toBe("こんにちは。");
		expect(r.publishedAt).toBeNull();
	});
});

describe("decide-then-reply timing and metrics", () => {
	const tagged = (
		kind: "decision" | "reply" | "cloud" | "single",
		over: Partial<CallMetrics>,
	) => ({
		kind,
		metrics: metric(over),
	});
	test("a decision's JSON text is never heard; a local reply is heard when it was published", () => {
		const t = timingOf(
			[
				tagged("decision", {
					startedAt: 1000,
					totalMs: 800,
					firstTokenMs: 30,
					firstTextMs: 40,
					firstContentMs: 40,
				}),
				tagged("reply", {
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
			1950,
		);
		expect(t.heardMs).toBe(950);
		expect(t).toMatchObject({
			calls: 2,
			decisionFirstTokenMs: 30,
			decisionFirstTextMs: 40,
			decisionMs: 800,
			replyFirstTokenMs: 50,
			replyFirstTextMs: 60,
			replyMs: 600,
		});
	});
	test("a cloud answer is heard at its first text; a hand-over at the end of its call", () => {
		const cloud = timingOf(
			[
				tagged("decision", {
					startedAt: 1000,
					totalMs: 500,
					firstContentMs: 10,
				}),
				tagged("cloud", {
					startedAt: 1500,
					totalMs: 2000,
					firstContentMs: 900,
				}),
			],
			1000,
			2500,
			false,
		);
		expect(cloud.heardMs).toBe(1400);
		const handed = timingOf(
			[
				tagged("decision", {
					startedAt: 1000,
					totalMs: 500,
					firstContentMs: 10,
				}),
			],
			1000,
			500,
			true,
		);
		expect(handed.heardMs).toBe(500);
		expect(handed.replyMs).toBeNull();
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
	const record = (over: Partial<StepRecord>): StepRecord => ({
		...timingOf([tagged("single", { firstContentMs: 500 })], 0, 1000, false),
		chain: "続けて頼む",
		form: "current",
		rep: 0,
		index: 0,
		say: "s",
		scored: true,
		pass: true,
		why: "",
		said: "",
		turnMode: "decide-then-reply",
		failedCheck: null,
		failedChecks: [],
		cloudAnswered: false,
		copyRun: 3,
		stop: "answer",
		callTokens: [],
		callDetails: [],
		...over,
	});
	test("a cell has the fallback rate, the cloud answers and the share of replies copying 20+ characters", () => {
		const cell = cellOf([
			record({}),
			record({
				failedCheck: "promise_without_call",
				failedChecks: ["promise_without_call"],
				pass: false,
				why: "fallback:promise_without_call",
				copyRun: null,
			}),
			record({
				failedCheck: "tool_unknown",
				failedChecks: ["tool_unknown"],
				cloudAnswered: true,
				copyRun: 25,
			}),
			record({ copyRun: 20, scored: false }),
		]);
		expect(cell.fallbackShare).toBe(0.5);
		expect(cell.cloudAnswered).toBe(1);
		// Three replies were measured, and two of them share 20 characters or more.
		expect(cell.copyShare).toBeCloseTo(2 / 3);
		expect(cellOf([record({ turnMode: "single" })]).fallbackShare).toBeNull();
		expect(cellOf([record({ copyRun: null })]).copyShare).toBeNull();
	});
	test("the Markdown carries the new columns, the phase timings and the failed checks", () => {
		const md = reportMarkdown(
			{
				startedAt: "2026-10-28T00:00:00.000Z",
				client: "larm",
				harness: "local",
				reasoning: "medium",
				outputLimit: 4096,
				reps: 1,
				probe: false,
				turn: "decide-then-reply",
				fallback: "なし（失敗として数える）",
				chains: ["続けて頼む"],
				forms: ["current"],
				settings: null,
			},
			[
				record({}),
				record({
					failedCheck: "tool_unknown",
					failedChecks: ["tool_unknown"],
					pass: false,
					why: "fallback:tool_unknown",
				}),
			],
		);
		expect(md).toContain("| ターン | decide-then-reply |");
		expect(md).toContain("fallback率 | cloud回答 | 前の返事の写し(20字以上)");
		expect(md).toContain("| 50% | 0 | 0% |");
		expect(md).toContain("## 判断と返事の時間");
		expect(md).toContain("- tool_unknown: 1");
		expect(checkCounts([record({})])).toEqual(["なし"]);
	});
});

describe("options and dry run for the turn", () => {
	test("the harness's own turn is the default; --turn and the fallback are checked", () => {
		expect(parseOptions([]).turn).toBe(localHarness.turn);
		const o = parseOptions(["--turn", "decide-then-reply"]);
		expect(o).toMatchObject({ turn: "decide-then-reply", fallbackModel: null });
		expect(() => parseOptions(["--turn", "x"])).toThrow("--turn");
		expect(() =>
			parseOptions([
				"--client",
				"codex",
				"--model",
				"m",
				"--turn",
				"decide-then-reply",
			]),
		).toThrow("LARM");
		expect(() =>
			parseOptions([
				"--turn",
				"decide-then-reply",
				"--fallback-client",
				"codex",
			]),
		).toThrow("--fallback-model");
		expect(() =>
			parseOptions(["--turn", "decide-then-reply", "--fallback-model", "m"]),
		).toThrow("--fallback-client");
		expect(() =>
			parseOptions(["--fallback-client", "codex", "--fallback-model", "m"]),
		).toThrow("--turn");
		expect(
			parseOptions([
				"--turn",
				"decide-then-reply",
				"--fallback-client",
				"codex",
				"--fallback-model",
				"m",
			]).fallbackModel,
		).toBe("m");
		expect(
			parseOptions([
				"--turn",
				"decide-then-reply",
				"--fallback-client",
				"codex",
				"--dry-run",
			]).fallbackModel,
		).toBe("");
	});
	test("the dry run of the decide-then-reply turn states the schema size and the two calls", () => {
		const notes = decisionNotes(false).join("\n");
		expect(notes).toMatch(/decision schema: \d+ chars, ~\d+ tokens/);
		expect(notes).toContain("tool_choice none");
		expect(notes).toContain("decision schema (as sent): {");
		const text = dryRunText(
			parseOptions([
				"--turn",
				"decide-then-reply",
				"--chains",
				"topic",
				"--dry-run",
			]),
			{
				source: {
					persona: { agentName: "", userName: "", persona: "butler" },
					interests: [],
					emotion: false,
					titles: ["画像生成"],
				},
				cards,
			},
		);
		expect(text).toContain("turn: decide-then-reply");
		expect(text).toContain(
			"(decision call: these 4 messages with the functions added to the last user message, +",
		);
		expect(
			dryRunText(parseOptions(["--chains", "topic", "--dry-run"]), {
				source: {
					persona: { agentName: "", userName: "", persona: "butler" },
					interests: [],
					emotion: false,
					titles: [],
				},
				cards,
			}),
		).toContain("turn: single");
	});
});

describe("the metrics fetch", () => {
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
	const delegateWithout = JSON.stringify({
		mode: "execute",
		toolchain: "image.create",
	});
	test("a decision that fails the argument check keeps its raw JSON, the call and the issues", async () => {
		const bad = call("delegate", {
			mode: "execute",
			toolchain: "image.create",
		});
		const r = await runTurn(
			env(fakeClient({ decisions: [bad] }).client),
			input("x"),
			cards,
			1,
		);
		expect(r.stop).toBe("check");
		const [d] = r.details;
		expect(d).toMatchObject({
			kind: "decision",
			check: "tool_arguments_invalid",
			decisionJson: bad,
		});
		expect(d!.toolCalls).toHaveLength(1);
		expect(d!.toolCalls[0]).toMatchObject({
			name: "delegate",
			arguments: delegateWithout,
			verdict: "refused",
			reason: "tool_arguments_invalid",
		});
		expect(d!.toolCalls[0]!.issues!.map((i) => i.path)).toContain("request");
	});
	test("an unreadable decision and an unknown tool say so in the record", async () => {
		const garbled = await runTurn(
			env(fakeClient({ decisions: ["not json"] }).client),
			input("x"),
			cards,
			1,
		);
		expect(garbled.details[0]).toMatchObject({
			decisionJson: "not json",
			check: "decision_unparsed",
		});
		expect(garbled.details[0]!.toolCalls[0]).toMatchObject({
			verdict: "refused",
			reason: "decision_unparsed",
		});
		const unknown = await runTurn(
			env(fakeClient({ decisions: [call("nope", { a: 1 })] }).client),
			input("x"),
			cards,
			1,
		);
		expect(unknown.details[0]!.toolCalls[0]).toMatchObject({
			name: "nope",
			arguments: '{"a":1}',
			reason: "tool_unknown",
		});
	});
	test("a search is accepted with its candidates, a hand-over to an unsearched toolchain is refused by the host, then the rounds run out", async () => {
		const search = call("find_toolchain", { query: "画像" });
		const wrong = call("delegate", {
			mode: "execute",
			toolchain: "music.create",
			request: "猫",
			impact: "create",
		});
		const r = await runTurn(
			env(fakeClient({ decisions: [search, wrong, wrong, wrong] }).client),
			input("猫の絵作って"),
			cards,
			1,
		);
		expect(r.stop).toBe("rounds");
		expect(r.details.map((d) => d.kind)).toEqual([
			"decision",
			"decision",
			"decision",
			"decision",
		]);
		expect(r.details[0]!.toolCalls[0]).toMatchObject({
			verdict: "accepted",
			outcome: "候補 image.create, model3d.studio, excalidraw.edit",
		});
		expect(r.details[1]!.toolCalls[0]).toMatchObject({ verdict: "refused" });
		expect(r.details[1]!.toolCalls[0]!.reason).toContain("toolchain_not_found");
		expect(r.details[1]!.toolCalls[0]!.reason).toContain("image.create");
		expect(r.details[1]!.decisionJson).toBe(wrong);
	});
	test("in a single turn the refusal of a call without its request is recorded with the path", async () => {
		const { client } = fakeClient({
			replies: [
				{
					chunks: [],
					toolCalls: [
						{ id: "a", name: "find_toolchain", arguments: '{"query":"画像"}' },
					],
				},
				{
					chunks: [],
					toolCalls: [
						{ id: "b", name: "delegate", arguments: delegateWithout },
					],
				},
				{ chunks: ["承りました。"] },
			],
		});
		const r = await runTurn(
			env(client, { mode: "single" }),
			input("猫の絵作って"),
			cards,
			1,
		);
		expect(r.details.map((d) => d.kind)).toEqual([
			"single",
			"single",
			"single",
		]);
		const refusedCall = r.details[1]!.toolCalls[0]!;
		expect(refusedCall).toMatchObject({
			name: "delegate",
			verdict: "refused",
			reason: "invalid_tool_arguments",
		});
		expect(refusedCall.issues!.some((i) => i.path.endsWith("request"))).toBe(
			true,
		);
		expect(r.details[2]).toMatchObject({
			text: "承りました。",
			textChars: 6,
			finishReason: "stop",
		});
		expect(r.stop).toBe("answer");
	});
	test("a stopped reply keeps the head that arrived and its check", async () => {
		const { client } = fakeClient({
			decisions: [REPLY],
			replies: [{ chunks: ["猫の絵を", "作ります。", "まだ続く。"] }],
		});
		const r = await runTurn(env(client), input("猫の絵作って"), cards, 1);
		const reply = r.details[1]!;
		expect(reply).toMatchObject({
			kind: "reply",
			check: "promise_without_call",
			text: "猫の絵を作ります。まだ続く。",
		});
		expect(reply.error).toBeUndefined();
		expect(r.details[0]).toMatchObject({
			kind: "decision",
			decisionJson: REPLY,
		});
	});
	test("an error that ends a call keeps its code and how much text had arrived", async () => {
		const { client } = fakeClient({
			replies: [
				{ chunks: ["こんにちは、", "ええと"], error: "chat_stream_incomplete" },
			],
		});
		const r = await runTurn(
			env(client, { mode: "single" }),
			input("やあ"),
			cards,
			1,
		);
		expect(r.stop).toBe("error");
		expect(r.error).toBe("chat_stream_incomplete");
		expect(r.details[0]!.error).toEqual({
			code: "chat_stream_incomplete",
			textChars: 9,
			reasoningChars: 0,
		});
		expect(r.details[0]!.text).toBe("こんにちは、ええと");
	});
	test("the helpers: cut, error code, the named call of a decision, issues of a refused call", () => {
		expect(cut("abcdef", 3)).toBe("abc…");
		expect(cut("abc", 3)).toBe("abc");
		expect(errorCodeOf(Object.assign(new Error("m"), { code: "c1" }))).toBe(
			"c1",
		);
		expect(errorCodeOf(new Error("chat_stream_incomplete"))).toBe(
			"chat_stream_incomplete",
		);
		expect(
			decisionCall(
				'{"action":"call","tool":{"name":"delegate","arguments":"{}"}}',
			),
		).toEqual({ name: "delegate", arguments: "{}", checked: "{}" });
		expect(decisionCall('{"action":"reply","tool":null}')).toBeNull();
		expect(decisionCall("x")).toBeNull();
		let failure: unknown;
		try {
			parseCall({ id: "i", name: "delegate", arguments: delegateWithout });
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(ValidationFailure);
		expect(issuesOf(failure as ValidationFailure)[0]).toMatchObject({
			code: expect.any(String),
			path: expect.stringContaining("request"),
		});
	});
	test("the details section lists each failed step's calls with tool, verdict and reason", async () => {
		const bad = call("delegate", {
			mode: "execute",
			toolchain: "image.create",
		});
		const r = await runTurn(
			env(fakeClient({ decisions: [bad] }).client),
			input("x"),
			cards,
			1,
		);
		const failed = {
			...timingOf(r.calls, 0, 100, false),
			chain: "続けて頼む",
			form: "current",
			rep: 0,
			index: 0,
			say: "猫の絵作って",
			scored: true,
			pass: false,
			why: "fallback:tool_arguments_invalid",
			said: "",
			turnMode: "decide-then-reply" as const,
			failedCheck: "tool_arguments_invalid",
			failedChecks: ["tool_arguments_invalid"],
			cloudAnswered: false,
			copyRun: null,
			stop: r.stop,
			callTokens: tokensOf(r.calls),
			callDetails: r.details,
		};
		const text = failureDetails([failed]).join("\n");
		expect(text).toContain(
			"続けて頼む / current / 回1 / 猫の絵作って: fallback:tool_arguments_invalid（終わり方: check、モデルの呼出し 1 回）",
		);
		expect(text).toContain("1. decision / finish=stop");
		expect(text).toContain("check=tool_arguments_invalid");
		expect(text).toContain(
			'delegate `{"mode":"execute","toolchain":"image.create"}` → 拒否 tool_arguments_invalid [request required expected string got undefined',
		);
		expect(failureDetails([{ ...failed, pass: true }])).toEqual(["なし"]);
		const md = reportMarkdown(
			{
				startedAt: "t",
				client: "larm",
				harness: "local",
				reasoning: "medium",
				outputLimit: 4096,
				reps: 1,
				probe: false,
				turn: "decide-then-reply",
				fallback: "-",
				chains: ["続けて頼む"],
				forms: ["current"],
				settings: null,
			},
			[failed],
		);
		expect(md).toContain("## 落ちた手の詳細");
		expect(md).toContain("拒否 tool_arguments_invalid");
		expect(detailLines(r.details[0]!, 1)[0]).toContain("1. decision");
	});
	test("the step record carries the details as JSON", async () => {
		const r = await runTurn(
			env(
				fakeClient({ decisions: [REPLY], replies: [{ chunks: ["はい。"] }] })
					.client,
			),
			input("ありがとう"),
			cards,
			1,
		);
		const roundTrip = JSON.parse(JSON.stringify(r.details));
		expect(roundTrip.map((d: { kind: string }) => d.kind)).toEqual([
			"decision",
			"reply",
		]);
		expect(roundTrip[1]).toMatchObject({
			text: "はい。",
			textChars: 3,
			toolCalls: [],
		});
	});
});

describe("the decision call's input", () => {
	test("the decision call reads the messages with the offered functions added to the last user message", async () => {
		const fake = fakeClient({
			decisions: [REPLY],
			replies: [{ chunks: ["はい。"] }],
		});
		const messages = input("ありがとう");
		await runTurn(env(fake.client), messages, cards, 1);
		const sent = fake.decided[0]!;
		expect(sent).toHaveLength(messages.length);
		expect(sent.at(-1)!.content.startsWith(messages.at(-1)!.content)).toBe(
			true,
		);
		expect(sent.at(-1)!.content).toContain("## Functions");
		expect(sent.at(-1)!.content).toContain('"name":"delegate"');
		expect(sent.slice(0, -1)).toEqual(messages.slice(0, -1));
	});
	test("the diagnosis form of a decision's arguments drops nulls and reads a JSON text as the object", () => {
		const named = decisionCall(
			JSON.stringify({
				action: "call",
				tool: {
					name: "delegate",
					arguments: {
						mode: "execute",
						target: null,
						inputs: '{"a":1}',
						request: "x",
					},
				},
			}),
		);
		expect(JSON.parse(named!.checked)).toEqual({
			mode: "execute",
			inputs: { a: 1 },
			request: "x",
		});
		expect(JSON.parse(named!.arguments)).toMatchObject({
			target: null,
			inputs: '{"a":1}',
		});
	});
});

describe("the cache figures", () => {
	const record = (over: Partial<StepRecord>): StepRecord => ({
		...timingOf([], 0, 0, false),
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
		callTokens: [],
		callDetails: [],
		...over,
	});
	test("the cached share counts every call, not only the first", () => {
		const cell = cellOf([
			record({
				callTokens: [
					{ kind: "single", promptTokens: 1000, cachedPromptTokens: 0 },
					{ kind: "single", promptTokens: 1000, cachedPromptTokens: 1000 },
				],
			}),
			record({
				callTokens: [
					{ kind: "single", promptTokens: null, cachedPromptTokens: null },
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
					{ kind: "single", promptTokens: 3800, cachedPromptTokens: 0 },
				],
			}),
			record({
				form: "empty",
				index: 1,
				callTokens: [
					{ kind: "decision", promptTokens: 3900, cachedPromptTokens: 3700 },
					{ kind: "reply", promptTokens: 3900, cachedPromptTokens: 3800 },
				],
			}),
		];
		const lines = cacheSection(rows);
		expect(lines[0]).toBe("## キャッシュ（呼出しごと）");
		expect(lines).toContain(
			"| 続けて頼む | current | 1 | 1 | 1 | single | 3800 | 0 | 0% |",
		);
		expect(lines).toContain(
			"| 続けて頼む | empty | 1 | 2 | 2 | reply | 3900 | 3800 | 97% |",
		);
		expect(cacheSection([record({})])).toEqual([]);
		const md = reportMarkdown(
			{
				startedAt: "t",
				client: "larm",
				harness: "local",
				reasoning: "medium",
				outputLimit: 4096,
				reps: 1,
				probe: false,
				turn: "single",
				fallback: "-",
				chains: ["続けて頼む"],
				forms: ["current", "empty"],
				settings: null,
			},
			rows,
		);
		expect(md).toContain("cache(全呼出し)");
		expect(md).toContain("## キャッシュ（呼出しごと）");
	});
});
