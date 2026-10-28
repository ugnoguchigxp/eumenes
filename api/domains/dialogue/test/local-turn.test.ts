import { expect, test } from "bun:test";
import type { CallSession, Receipt } from "../../inference";
import type {
	ChatMessage,
	DialogueDeps,
	GenerateInput,
} from "../service/context";
import { localHarness } from "../service/harness";
import { runGeneration } from "../service/generation-loop";
import { generationTools, parseCall } from "../service/generation-tools";
import {
	decisionMessages,
	decisionSchema,
	headEnd,
	parseDecision,
	runLocalTurn,
} from "../service/local-turn";
import { testConversationAgent } from "./conversation-agent.fixture";

/**
 * The local harness's decide-then-reply turn (the conversation harness design, section 5.3), run through the
 * production loop with a model scripted per kind of call: the decision (`outputSchema`), the reply (`toolChoice:
 * none`) and the cloud (`target: cloud`).
 */
type Kind = "decide" | "reply" | "cloud" | "single";
type Scripted = {
	/** The text streamed in these parts (the receipt's value is their join unless `value` is given). */
	parts?: string[];
	value?: string;
	calls?: Array<{ name: string; args: unknown }>;
	/** Runs between the parts, to observe what has been published by then. */
	between?: () => void;
	fail?: Error;
};

const PREPARATION = { speech: true } as never;
const SYSTEM = "## Role\nあなたは会話の担当で、短く丁寧に答えます。";
const DECIDE_REPLY = JSON.stringify({ action: "reply" });
const decideCall = (name: string, args: unknown) =>
	JSON.stringify({
		action: "call",
		tool: { name, arguments: args },
	});

function kindOf(session: CallSession | undefined): Kind {
	if (session?.outputSchema) return "decide";
	if (session?.target === "cloud") return "cloud";
	if (session?.toolChoice === "none") return "reply";
	return "single";
}

function setup(
	script: Partial<Record<Kind, Scripted[]>>,
	options: {
		turn?: "single" | "decide-then-reply";
		history?: Array<{ role: "user" | "assistant"; content: string }>;
		user?: string;
		candidates?: boolean;
	} = {},
) {
	const calls: Array<{
		kind: Kind;
		messages: ChatMessage[];
		session?: CallSession;
		tools: string[];
		hasDelta: boolean;
		/** The delta function threw (the turn stopped the call). */
		deltaThrew: boolean;
		/** What the delta function returned for each piece. */
		returns: unknown[];
		preparation: unknown;
		signal: AbortSignal;
	}> = [];
	const published: string[] = [];
	const queues = new Map(
		Object.entries(script).map(([kind, steps]) => [kind, [...steps!]]),
	);
	const deps = {
		larm: {
			answer: async () => {
				throw new Error("unexpected_answer");
			},
			executeStream: async (
				requestId: string,
				messages: ChatMessage[],
				signal: AbortSignal,
				onDelta: ((text: string) => void) | undefined,
				preparation: unknown,
				tools: Array<{ function: { name: string } }> | undefined,
				session?: CallSession,
			) => {
				const kind = kindOf(session);
				calls.push({
					kind,
					messages: messages.map((m) => ({ ...m })),
					...(session ? { session } : {}),
					tools: (tools ?? []).map((t) => t.function.name),
					hasDelta: !!onDelta,
					deltaThrew: false,
					returns: [],
					preparation,
					signal,
				});
				const record = calls.at(-1)!;
				const step = queues.get(kind)?.shift();
				if (!step) throw new Error(`script_missing:${kind}`);
				if (step.fail) throw step.fail;
				for (const [i, part] of (step.parts ?? []).entries()) {
					if (i) step.between?.();
					signal.throwIfAborted();
					try {
						record.returns.push(onDelta?.(part));
					} catch (error) {
						record.deltaThrew = true;
						throw error;
					}
				}
				return {
					requestId,
					attemptId: `attempt-${calls.length}`,
					value: step.value ?? (step.parts ?? []).join(""),
					toolCalls: (step.calls ?? []).map((c) => ({
						id: `id-${calls.length}`,
						name: c.name,
						arguments: JSON.stringify(c.args),
					})),
				} as Receipt;
			},
		},
		conversationAgent: testConversationAgent,
	} as unknown as DialogueDeps;
	const input = {
		requestId: "request",
		harness: {
			...localHarness,
			turn: options.turn ?? "decide-then-reply",
		},
		messages: [
			{ role: "system", content: SYSTEM },
			...(options.history ?? []),
			{ role: "user", content: `## User\n${options.user ?? "こんにちは"}` },
		],
	} as unknown as GenerateInput;
	const executed: string[] = [];
	const run = () =>
		runGeneration(deps, input, {
			signal: new AbortController().signal,
			preparation: PREPARATION,
			delta: (text) => published.push(text),
			execute: async (call) => {
				executed.push(call.name);
				return {
					result:
						call.name === "find_toolchain"
							? {
									candidates:
										options.candidates === false
											? []
											: [
													{
														id: "fake.image",
														title: "画像",
														summary: "画像を作る",
														execution: "image",
													},
												],
								}
							: {},
				};
			},
		});
	return {
		calls,
		published,
		executed,
		run,
		kinds: () => calls.map((c) => c.kind),
		speech: () => published.join(""),
	};
}

const search = { name: "find_toolchain", args: { query: "絵を描く" } };

test("a decision to call a tool returns the call without any reply call", async () => {
	const t = setup({
		decide: [
			{ parts: [decideCall("find_toolchain", search.args)] },
			{ parts: [DECIDE_REPLY] },
		],
		reply: [{ parts: ["どんな絵にしましょうか？色は決めますか？"] }],
	});
	const out = await t.run();
	expect(t.executed).toEqual(["find_toolchain"]);
	expect(t.kinds()).toEqual(["decide", "decide", "reply"]);
	expect(out.text).toBe("どんな絵にしましょうか？色は決めますか？");
	expect(out.executed).toHaveLength(1);
});

test("the decision call has the schema and no tools, no delta; the reply call offers the tools and none can be called", async () => {
	const t = setup({
		decide: [{ parts: [DECIDE_REPLY] }],
		reply: [{ parts: ["こんにちは。今日はいい天気ですね。"] }],
	});
	const out = await t.run();
	const [decide, reply] = t.calls;
	expect(decide!.tools).toEqual([]);
	expect(decide!.hasDelta).toBe(false);
	expect(decide!.session?.outputSchema).toEqual(
		decisionSchema(generationTools),
	);
	expect(decide!.session?.sessionRole).toBe("main");
	expect(reply!.tools).toEqual(generationTools.map((x) => x.function.name));
	expect(reply!.session?.toolChoice).toBe("none");
	expect(reply!.session?.retainRequest).toBe(true);
	expect(decide!.session?.retainRequest).toBeUndefined();
	expect(out.receipt?.attemptId).toBe("attempt-2");
	expect(out.text).toBe("こんにちは。今日はいい天気ですね。");
});

test("the reply's head is held until it is known, then published with the rest as it streams", async () => {
	const seen: string[] = [];
	let t: ReturnType<typeof setup>;
	const probe = () => seen.push(t.speech());
	t = setup({
		decide: [{ parts: [DECIDE_REPLY] }],
		reply: [
			{
				parts: [
					"😊 こんにちは",
					"、お元気",
					"ですか？",
					"今日は",
					"晴れです。",
				],
				between: probe,
			},
		],
	});
	const out = await t.run();
	// Held through "こんにちは、お元気"; the head ends at "ですか？" (13 characters after the emoji and space).
	expect(seen).toEqual([
		"",
		"",
		"😊 こんにちは、お元気ですか？",
		"😊 こんにちは、お元気ですか？今日は",
	]);
	expect(out.text).toBe("😊 こんにちは、お元気ですか？今日は晴れです。");
});

test("a head ends at 40 characters when no sentence ends", () => {
	const long = "あ".repeat(60);
	expect(headEnd(long, false)).toBe(40);
	expect(headEnd("あ".repeat(10) + "。", false)).toBeNull();
	expect(headEnd("あ".repeat(10) + "。", true)).toBe(11);
	expect(headEnd("あ".repeat(10) + "。い", false)).toBeNull();
	expect(headEnd("あ".repeat(12) + "。", false)).toBe(13);
	expect(headEnd("😊 " + "あ".repeat(12) + "。", false)).toBe(
		"😊 ".length + 13,
	);
});

const PREVIOUS = "今日は東京も晴れて、気持ちのいい一日になりそうですね。";
const failing: Array<{
	check: string;
	script: Partial<Record<Kind, Scripted[]>>;
	options?: Parameters<typeof setup>[1];
}> = [
	{
		check: "decision_unparsed",
		script: { decide: [{ parts: ["考え中です"] }] },
	},
	{
		check: "tool_unknown",
		script: { decide: [{ parts: [decideCall("nope", {})] }] },
	},
	{
		check: "tool_arguments_invalid",
		script: { decide: [{ parts: [decideCall("find_toolchain", {})] }] },
	},
	{
		check: "searched_not_handed",
		script: {
			decide: [
				{ parts: [decideCall("find_toolchain", search.args)] },
				{ parts: [DECIDE_REPLY] },
			],
			reply: [{ parts: ["画像の担当が見つかりました。ご安心ください。"] }],
		},
	},
	{
		check: "promise_without_call",
		script: {
			decide: [{ parts: [DECIDE_REPLY] }],
			reply: [
				{ parts: ["承知しました。画像を作ります。少々お待ちください。"] },
			],
		},
		options: { user: "猫の絵を描いて" },
	},
	{
		check: "previous_reply_copied",
		script: {
			decide: [{ parts: [DECIDE_REPLY] }],
			reply: [{ parts: [PREVIOUS] }],
		},
		options: {
			history: [
				{ role: "user", content: "今日の天気は" },
				{ role: "assistant", content: PREVIOUS },
				{ role: "user", content: "ありがとう" },
			],
			user: "それでどうする",
		},
	},
	{
		check: "previous_reply_copied",
		script: {
			decide: [{ parts: [DECIDE_REPLY] }],
			reply: [{ parts: ["つまり、" + PREVIOUS.slice(2) + "と思います。"] }],
		},
		options: {
			history: [
				{ role: "user", content: "今日の天気は" },
				{ role: "assistant", content: PREVIOUS },
				{ role: "user", content: "ありがとう" },
			],
			user: "それでどうする",
		},
	},
	{
		check: "input_copied",
		script: {
			decide: [{ parts: [DECIDE_REPLY] }],
			reply: [{ parts: ["## State\n- t1 実行中です。"] }],
		},
	},
	{
		check: "input_copied",
		script: {
			decide: [{ parts: [DECIDE_REPLY] }],
			reply: [
				{
					parts: [
						"あなたは会話の担当で、短く丁寧に答えます。と言われています。",
					],
				},
			],
		},
	},
];

for (const { check, script, options } of failing)
	test(`a failed check (${check}) speaks nothing of the local answer and answers on the cloud`, async () => {
		const t = setup(
			{ ...script, cloud: [{ parts: ["クラウドの返事です。"] }] },
			options,
		);
		const out = await t.run();
		expect(t.kinds().at(-1)).toBe("cloud");
		const cloud = t.calls.at(-1)!;
		expect(cloud.session?.target).toBe("cloud");
		expect(cloud.session?.outputSchema).toBeUndefined();
		expect(cloud.session?.toolChoice).toBeUndefined();
		expect(cloud.tools).toEqual(generationTools.map((x) => x.function.name));
		expect(cloud.session?.retainRequest).toBeUndefined();
		// The run's own signal is passed on as it is and never aborted to stop the local call.
		expect(t.calls.every((c) => c.signal === t.calls[0]!.signal)).toBe(true);
		expect(t.calls.some((c) => c.signal.aborted)).toBe(false);
		expect(t.speech()).toBe("クラウドの返事です。");
		expect(out.text).toBe("クラウドの返事です。");
		expect(out.receipt?.attemptId).toBe(`attempt-${t.calls.length}`);
	});

test("the reply's delta returns false for every held piece and nothing once it publishes", async () => {
	const t = setup({
		decide: [{ parts: [DECIDE_REPLY] }],
		reply: [
			{ parts: ["こんにちは", "、お元気", "ですか？", "今日は", "晴れです。"] },
		],
	});
	await t.run();
	expect(t.calls[1]!.returns).toEqual([
		false,
		false,
		undefined,
		undefined,
		undefined,
	]);
});

test("a multi-piece head that fails holds every piece it received (false) and then stops the call", async () => {
	const t = setup({
		decide: [{ parts: [DECIDE_REPLY] }],
		reply: [{ parts: ["承知しました。", "画像を", "作ります。", "続き"] }],
		cloud: [{ parts: ["クラウドの返事です。"] }],
	});
	await t.run();
	const reply = t.calls[1]!;
	expect(reply.returns).toEqual([false, false]);
	expect(reply.deltaThrew).toBe(true);
	expect(t.speech()).toBe("クラウドの返事です。");
});

test("after a search with candidates every piece is held", async () => {
	const t = setup({
		decide: [
			{ parts: [decideCall("find_toolchain", search.args)] },
			{ parts: [DECIDE_REPLY] },
		],
		reply: [
			{ parts: ["画像の担当が見つかりました。", "どんな絵に", "しますか？"] },
		],
	});
	await t.run();
	expect(t.calls[2]!.returns).toEqual([false, false, false]);
});

test("the silent decision call collects no speech; the reply and the cloud calls do", async () => {
	const t = setup({
		decide: [{ parts: [DECIDE_REPLY] }],
		reply: [{ parts: ["## State"] }],
		cloud: [{ parts: ["クラウドの返事です。"] }],
	});
	await t.run();
	expect(t.calls.map((c) => c.preparation)).toEqual([
		undefined,
		PREPARATION,
		PREPARATION,
	]);
});

test("a search that is not the latest tool result does not hold the reply to a question", async () => {
	const t = setup({
		decide: [
			{ parts: [decideCall("find_toolchain", search.args)] },
			{ parts: [decideCall("memory", { operation: "read", query: "猫" })] },
			{ parts: [DECIDE_REPLY] },
		],
		reply: [{ parts: ["画像の担当が見つかりました。ご安心ください。"] }],
	});
	await t.run();
	expect(t.kinds()).toEqual(["decide", "decide", "decide", "reply"]);
	expect(t.calls[3]!.returns).toEqual([undefined]);
});

test("a progressive or waiting form is not a promise; a reply ending in か is a question", async () => {
	const progressive = setup({
		decide: [{ parts: [DECIDE_REPLY] }],
		reply: [{ parts: ["猫の絵を今作っています。少しお待ちください。"] }],
	});
	await progressive.run();
	expect(progressive.kinds()).toEqual(["decide", "reply"]);
	const asking = setup({
		decide: [
			{ parts: [decideCall("find_toolchain", search.args)] },
			{ parts: [DECIDE_REPLY] },
		],
		reply: [
			{ parts: ["画像の担当が見つかりました。この絵でよろしいですか。"] },
		],
	});
	await asking.run();
	expect(asking.kinds()).toEqual(["decide", "decide", "reply"]);
});

test("with no tool offered there is no decision call and the reply call asks for no tool choice", async () => {
	const calls: string[] = [];
	const out = await runLocalTurn(
		{
			decide: async () => {
				throw new Error("unexpected_decision");
			},
			reply: async (onDelta) => {
				calls.push("reply");
				onDelta("こんにちは。今日はいい天気ですね。");
				return { value: "こんにちは。今日はいい天気ですね。" } as never;
			},
			cloud: async () => {
				throw new Error("unexpected_cloud");
			},
		},
		{
			base: [],
			own: [],
			offered: [],
			output: { delta: () => {}, finish: (text) => text },
			signal: new AbortController().signal,
		},
	);
	expect(calls).toEqual(["reply"]);
	expect(out.text).toBe("こんにちは。今日はいい天気ですね。");
});

test("a failed head stops the reply call by throwing from its delta, and the later cloud call is not aborted", async () => {
	const t = setup({
		decide: [{ parts: [DECIDE_REPLY] }],
		reply: [
			{ parts: ["承知しました。画像を作ります。", "少々お待ちください。"] },
		],
		cloud: [{ parts: ["クラウドの返事です。"] }],
	});
	await t.run();
	expect(t.kinds()).toEqual(["decide", "reply", "cloud"]);
	expect(t.calls.map((c) => c.deltaThrew)).toEqual([false, true, false]);
	expect(t.calls[1]!.session?.retainRequest).toBe(true);
});

test("after a search with candidates the reply is held to its end: a statement that goes on to ask passes", async () => {
	const seen: string[] = [];
	let t: ReturnType<typeof setup>;
	t = setup({
		decide: [
			{ parts: [decideCall("find_toolchain", search.args)] },
			{ parts: [DECIDE_REPLY] },
		],
		reply: [
			{
				parts: ["画像の担当が見つかりました。", "どんな絵に", "しますか？"],
				between: () => seen.push(t.speech()),
			},
		],
	});
	const out = await t.run();
	expect(t.kinds()).toEqual(["decide", "decide", "reply"]);
	expect(seen).toEqual(["", ""]);
	expect(out.text).toBe("画像の担当が見つかりました。どんな絵にしますか？");
	expect(t.published.join("")).toBe(out.text);
});

test("after a search with candidates, a reply that neither asks nor refuses fails even when it runs long", async () => {
	const t = setup({
		decide: [
			{ parts: [decideCall("find_toolchain", search.args)] },
			{ parts: [DECIDE_REPLY] },
		],
		reply: [
			{
				parts: [
					"画像の担当が見つかりました。",
					"それでは、少し待っていてください。",
				],
			},
		],
		cloud: [{ parts: ["クラウドの返事です。"] }],
	});
	await t.run();
	expect(t.kinds()).toEqual(["decide", "decide", "reply", "cloud"]);
	// The reply ended on its own; the held text was never published.
	expect(t.calls[2]!.deltaThrew).toBe(false);
	expect(t.speech()).toBe("クラウドの返事です。");
});

test("a head that repeats the last reply passes when the user asks to hear it again", async () => {
	const t = setup(
		{ decide: [{ parts: [DECIDE_REPLY] }], reply: [{ parts: [PREVIOUS] }] },
		{
			history: [
				{ role: "user", content: "今日の天気は" },
				{ role: "assistant", content: PREVIOUS },
				{ role: "user", content: "ありがとう" },
			],
			user: "もう一回言って",
		},
	);
	expect((await t.run()).text).toBe(PREVIOUS);
	expect(t.kinds()).toEqual(["decide", "reply"]);
});

test("after a search that found nothing, or when the head asks or refuses, the reply passes", async () => {
	for (const [candidates, text] of [
		[true, "見つかりません。お力になれず申し訳ありません。"],
		[true, "どんな絵がいいですか？"],
		[false, "画像の担当が見つかりました。ご安心ください。"],
	] as const) {
		const t = setup(
			{
				decide: [
					{ parts: [decideCall("find_toolchain", search.args)] },
					{ parts: [DECIDE_REPLY] },
				],
				reply: [{ parts: [text] }],
			},
			{ candidates },
		);
		expect((await t.run()).text).toBe(text);
		expect(t.kinds()).toEqual(["decide", "decide", "reply"]);
	}
});

test("a promise after a tool call is not a promise without one", async () => {
	const t = setup({
		decide: [
			{ parts: [decideCall("find_toolchain", search.args)] },
			{ parts: [DECIDE_REPLY] },
		],
		reply: [{ parts: ["絵のことは調べます。どんな絵がいいですか？"] }],
	});
	await t.run();
	expect(t.kinds()).toEqual(["decide", "decide", "reply"]);
});

test("a reply that fell back to the cloud and called a tool is that tool call, unchecked", async () => {
	const t = setup({
		decide: [{ parts: [DECIDE_REPLY] }, { parts: [DECIDE_REPLY] }],
		reply: [
			{ parts: ["画像を作ります。"], calls: [search] },
			{ parts: ["どんな絵がいいですか？"] },
		],
	});
	const out = await t.run();
	expect(t.executed).toEqual(["find_toolchain"]);
	expect(t.kinds()).toEqual(["decide", "reply", "decide", "reply"]);
	// The words said with the call stay said, as in a single call.
	expect(out.text).toBe("画像を作ります。どんな絵がいいですか？");
});

test("a cloud that cannot answer fails the generation; nothing of the local answer was spoken", async () => {
	const t = setup({
		decide: [{ parts: [DECIDE_REPLY] }],
		reply: [{ parts: ["## State\nコピーです。"] }],
		cloud: [{ fail: new Error("cloud_fallback_unavailable") }],
	});
	await expect(t.run()).rejects.toThrow("cloud_fallback_unavailable");
	expect(t.published).toEqual([]);
});

test("a provider error of the local reply is not a failed check: it ends the generation", async () => {
	const t = setup({
		decide: [{ parts: [DECIDE_REPLY] }],
		reply: [{ fail: new Error("llm_unavailable") }],
		cloud: [{ parts: ["使われません。"] }],
	});
	await expect(t.run()).rejects.toThrow("llm_unavailable");
	expect(t.kinds()).toEqual(["decide", "reply"]);
});

test("the single turn makes one call as before: no schema, no tool choice, no target", async () => {
	const t = setup(
		{ single: [{ parts: ["承知しました。画像を作ります。"] }] },
		{ turn: "single" },
	);
	const out = await t.run();
	expect(t.kinds()).toEqual(["single"]);
	expect(t.calls[0]!.session).not.toHaveProperty("outputSchema");
	expect(t.calls[0]!.session).not.toHaveProperty("target");
	expect(t.calls[0]!.session).not.toHaveProperty("toolChoice");
	expect(out.text).toBe("承知しました。画像を作ります。");
});

/** Every object of a schema is closed with all its properties required; none is free-form. */
function strictProblems(schema: unknown, path = "$"): string[] {
	if (Array.isArray(schema))
		return schema.flatMap((item, i) => strictProblems(item, `${path}[${i}]`));
	if (!schema || typeof schema !== "object") return [];
	const node = schema as Record<string, unknown>;
	const here: string[] = [];
	if (node.type === "object") {
		const keys = Object.keys((node.properties as object | undefined) ?? {});
		if (node.additionalProperties !== false) here.push(`${path} open`);
		if (!keys.length) here.push(`${path} free-form`);
		if (
			JSON.stringify([...(node.required as string[])].sort()) !==
			JSON.stringify(keys.sort())
		)
			here.push(`${path} not all required`);
	}
	return [
		...here,
		...Object.entries(node).flatMap(([key, value]) =>
			strictProblems(value, `${path}.${key}`),
		),
	];
}

type Branch = {
	required: string[];
	properties: {
		action: { enum: string[] };
		tool?: {
			properties: {
				name: { enum: string[] };
				arguments: {
					required: string[];
					properties: Record<string, Record<string, any>>;
				};
			};
		};
	};
};
const branchesOf = () =>
	(decisionSchema(generationTools) as unknown as { anyOf: Branch[] }).anyOf;
/** The shape's discriminating value (`mode` or `operation`), if it has one. */
const shapeOf = (branch: Branch) => {
	const properties = branch.properties.tool!.properties.arguments.properties;
	const key = properties.mode
		? "mode"
		: properties.operation
			? "operation"
			: null;
	return key && properties[key]!.enum?.length === 1
		? properties[key]!.enum[0]
		: null;
};
const callBranch = (name: string, shape?: string) =>
	branchesOf().find(
		(b) =>
			b.properties.tool?.properties.name.enum[0] === name &&
			(shape === undefined || shapeOf(b) === shape),
	)!;

test("the decision schema is strict-valid in every branch: reply alone, or call with exactly one tool shape", () => {
	const schema = decisionSchema(generationTools);
	expect(strictProblems(schema)).toEqual([]);
	const [reply, ...calls] = branchesOf();
	// Reply carries no tool; every call branch requires one.
	expect(reply).toMatchObject({
		required: ["action"],
		properties: { action: { enum: ["reply"] } },
	});
	expect(Object.keys(reply!.properties)).toEqual(["action"]);
	expect(calls).toHaveLength(6);
	for (const branch of calls) {
		expect(branch.required).toEqual(["action", "tool"]);
		expect(branch.properties.action.enum).toEqual(["call"]);
	}
	expect(
		calls.map((b) => [b.properties.tool!.properties.name.enum[0], shapeOf(b)]),
	).toEqual([
		["memory", "read"],
		["memory", "request"],
		["find_toolchain", null],
		["delegate", null],
		["delegate", "approve"],
		["work", null],
	]);
});

test("each shape carries only the fields it uses; resolveUnsaved is in none", () => {
	const keys = (name: string, shape?: string) =>
		Object.keys(
			callBranch(name, shape).properties.tool!.properties.arguments.properties,
		);
	expect(keys("memory", "read")).toEqual(["operation", "query"]);
	expect(keys("memory", "request")).toEqual([
		"operation",
		"kind",
		"what",
		"detail",
	]);
	expect(keys("find_toolchain")).toEqual(["query"]);
	expect(keys("delegate", "approve")).toEqual([
		"mode",
		"confirmation",
		"announcement",
	]);
	expect(keys("work")).toEqual(["todo", "operation", "text"]);
	const execute = callBranch("delegate").properties.tool!.properties.arguments;
	expect(Object.keys(execute.properties)).toEqual([
		"mode",
		"toolchain",
		"request",
		"impact",
		"announcement",
		"inputs",
		"target",
		"refs",
	]);
	expect(execute.properties.mode!.enum).toEqual(["execute", "confirm"]);
	expect(execute.properties.impact!.enum).toContain("irreversible");
	// Unused fields are nullable with a note; the free-form object is text; the list stays a list.
	expect(execute.properties.target!.anyOf[1]).toEqual({ type: "null" });
	expect(execute.properties.target!.anyOf[0].description).toContain(
		"使わないときは null",
	);
	expect(execute.properties.inputs!.anyOf[0].type).toBe("string");
	expect(execute.properties.refs!.anyOf[0]).toMatchObject({
		type: "array",
		items: { type: "string" },
	});
	expect(JSON.stringify(decisionSchema(generationTools))).not.toContain(
		"resolveUnsaved",
	);
});

/** A shape's arguments object as the model fills it: the named values, every other field null. */
function strictArguments(
	name: string,
	shape: string | undefined,
	values: Record<string, unknown>,
) {
	const properties = callBranch(name, shape).properties.tool!.properties
		.arguments.properties;
	return Object.fromEntries(
		Object.keys(properties).map((key) => [key, values[key] ?? null]),
	);
}

test("a decision of every shape round-trips into a call the existing check accepts", () => {
	const names = generationTools.map((x) => x.function.name);
	const cases: Array<
		[string, string | undefined, Record<string, unknown>, unknown]
	> = [
		[
			"memory",
			"read",
			{ operation: "read", query: "猫" },
			{ operation: "read", query: "猫" },
		],
		[
			"memory",
			"request",
			{ operation: "request", kind: "remember", what: "猫が好き" },
			{ operation: "request", kind: "remember", what: "猫が好き" },
		],
		["find_toolchain", undefined, { query: "絵を描く" }, { query: "絵を描く" }],
		[
			"delegate",
			undefined,
			{
				mode: "execute",
				toolchain: "fake.clock",
				request: "東京の時刻",
				impact: "none",
				inputs: '{"city":"東京"}',
				refs: ["a1"],
			},
			{
				mode: "execute",
				toolchain: "fake.clock",
				request: "東京の時刻",
				impact: "none",
				inputs: { city: "東京" },
				refs: ["a1"],
			},
		],
		[
			"delegate",
			undefined,
			{
				mode: "confirm",
				toolchain: "fake.clock",
				request: "消す",
				impact: "irreversible",
				announcement: "消してよいですか。",
			},
			{
				mode: "confirm",
				toolchain: "fake.clock",
				request: "消す",
				impact: "irreversible",
				announcement: "消してよいですか。",
			},
		],
		[
			"delegate",
			"approve",
			{ mode: "approve", confirmation: "c1" },
			{ mode: "approve", confirmation: "c1" },
		],
		[
			"work",
			undefined,
			{ todo: "t1", operation: "answer", text: "はい" },
			{ todo: "t1", operation: "answer", text: "はい" },
		],
	];
	for (const [name, shape, values, expected] of cases) {
		const decision = parseDecision(
			decideCall(name, strictArguments(name, shape, values)),
			names,
		);
		expect(decision).toMatchObject({ action: "call", call: { name } });
		if (decision.action !== "call") continue;
		expect(JSON.parse(decision.call.arguments)).toEqual(expected);
		expect(parseCall(decision.call).name as string).toBe(name);
	}
	// Text that is not a JSON object where an object is wanted is invalid arguments.
	for (const inputs of ["東京", "[1]"])
		expect(
			parseDecision(
				decideCall(
					"delegate",
					strictArguments("delegate", undefined, {
						mode: "execute",
						toolchain: "t",
						request: "r",
						impact: "none",
						inputs,
					}),
				),
				names,
			),
		).toEqual({ action: "failed", check: "tool_arguments_invalid" });
});

test("the decision messages change only the last user message, by one section listing the functions", () => {
	const messages = [
		{ role: "system", content: SYSTEM },
		{ role: "user", content: "## Memory\n- なし" },
		{ role: "assistant", content: "はい" },
		{ role: "user", content: "## User\nこんにちは" },
	] as ChatMessage[];
	const copy = structuredClone(messages);
	const sent = decisionMessages(messages, generationTools);
	expect(messages).toEqual(copy);
	expect(sent.slice(0, 3)).toEqual(copy.slice(0, 3));
	expect(
		sent[3]!.content.startsWith("## User\nこんにちは\n\n## Functions\n"),
	).toBe(true);
	const lines = sent[3]!.content.split("\n## Functions\n")[1]!.split("\n");
	expect(lines.map((line) => JSON.parse(line))).toEqual(
		generationTools.map((x) => x.function),
	);
});

test("the decision call reads the messages with the functions; the reply call reads today's", async () => {
	const t = setup({
		decide: [{ parts: [DECIDE_REPLY] }],
		reply: [{ parts: ["こんにちは。今日はいい天気ですね。"] }],
	});
	await t.run();
	const [decide, reply] = t.calls;
	expect(decide!.messages.at(-1)!.content).toContain("\n\n## Functions\n");
	expect(reply!.messages.at(-1)!.content).not.toContain("## Functions");
	expect(decide!.messages.slice(0, -1)).toEqual(reply!.messages.slice(0, -1));
});

test("a decision is read as reply, as a checked call, or as a failure", () => {
	const names = generationTools.map((x) => x.function.name);
	expect(parseDecision(DECIDE_REPLY, names)).toEqual({ action: "reply" });
	const call = parseDecision(decideCall("find_toolchain", search.args), names);
	expect(call).toMatchObject({
		action: "call",
		call: { name: "find_toolchain", arguments: '{"query":"絵を描く"}' },
	});
	for (const text of [
		"",
		"[]",
		'{"action":"call","tool":null}',
		'{"action":"reply","tool":{"name":"work","arguments":{}}}',
		'{"action":"call","tool":{"name":"work","arguments":"{}"}}',
	])
		expect(parseDecision(text, names)).toEqual({
			action: "failed",
			check: "decision_unparsed",
		});
	expect(parseDecision(decideCall("nope", {}), names)).toEqual({
		action: "failed",
		check: "tool_unknown",
	});
	expect(parseDecision(decideCall("work", { todo: "t1" }), names)).toEqual({
		action: "failed",
		check: "tool_arguments_invalid",
	});
});
