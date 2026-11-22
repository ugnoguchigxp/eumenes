import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { saveItem } from "../../domains/memory/test/memory.fixture";
import { settle } from "../../infrastructure/wait-for";
import { READ_MEMORY_LIMIT } from "../../domains/dialogue";
import { KNOWN_LIMIT, knownOf, readMemoryRefs } from "./always-on-scope";
import { seenRefs } from "./always-on-flow";
import { agendaFixture, replyWith, type CallKind } from "./always-on.fixture";
import { goalConversation } from "./goal-agenda.fixture";
import type { AgencyHostDeps } from "./host-types";

const STATE_DATA = /<あなたの今の状態[^>]*>(.*)<\/あなたの今の状態>/su;

async function remembered(f: Awaited<ReturnType<typeof agendaFixture>>) {
	await f.user("user-a", "ao", "朝はコーヒーを飲む");
	return saveItem(f.h.store, f.h.memory!, {
		conversationId: "ao",
		messageId: "user-a",
		kind: "preference",
		semanticKey: "drink",
		text: "朝はコーヒーを飲む",
	});
}

test("the state a reply reads has neither the time nor the memory, and is the start of the user's last message", async () => {
	const f = await agendaFixture();
	try {
		await f.start();
		await remembered(f);
		const { seen } = await replyWith(f, []);
		const roles = seen[0]!.map((m) => m.role);
		// The state is a section of the last message: the user's role never comes twice in a row.
		expect(roles).toEqual(["system", "user"]);
		const content = seen[0]![1]!.content;
		expect(content).toStartWith("## Agency\n<あなたの今の状態");
		expect(content).toEndWith("\n\n## User\nfixture user");
		const data = JSON.parse(STATE_DATA.exec(content)![1]!);
		expect(Object.keys(data)).not.toContain("now");
		expect(Object.keys(data)).not.toContain("memory");
		expect(content).not.toContain("朝はコーヒー");
		expect(Object.keys(data)).toEqual(
			expect.arrayContaining(["notes", "quiet", "researching"]),
		);
	} finally {
		await f.close();
	}
});

test("what read_memory returns is recorded as given: forgetting it refuses the reply, forgetting what it did not read does not", async () => {
	const f = await agendaFixture();
	try {
		await f.start();
		const item = await remembered(f);
		await f.user("user-b", "ao", "夜は紅茶を飲む");
		const other = await saveItem(f.h.store, f.h.memory!, {
			conversationId: "ao",
			messageId: "user-b",
			kind: "preference",
			semanticKey: "night",
			text: "夜は紅茶を飲む",
		});
		const given = (runId: string) =>
			f.h.store.read((db) =>
				f.host.dialoguePort.replyInputInTransaction!(db, runId),
			);
		await replyWith(f, [], { runId: "run-plain", messageIds: ["user-b"] });
		await replyWith(
			f,
			[{ name: "read_memory", arguments: { query: "コーヒー" } }],
			{ runId: "run-read", messageIds: ["user-b"], hostTools: ["read_memory"] },
		);
		expect(given("run-read")?.sources).toContain(`memory:${item.id}`);
		expect(given("run-read")?.complete).toBe(true);
		expect(given("run-plain")?.sources).not.toContain(`memory:${item.id}`);
		await f.h.memory!.forget({
			conversationId: "ao",
			messageIds: [],
			itemIds: [item.id],
		});
		expect(given("run-read")?.complete).toBe(false);
		// The reply that read nothing of it rests on nothing of it.
		expect(given("run-plain")?.complete).toBe(true);
		expect(other.id).not.toBe(item.id);
	} finally {
		await f.close();
	}
});

test("a memory corrected while read_memory runs is recorded as given in both its versions", async () => {
	const f = await agendaFixture();
	try {
		await f.start();
		const before = await remembered(f);
		await f.user("user-b", "ao", "朝はコーヒーをやめた");
		const respond = f.host.conversationAgent.respond.bind(
			f.host.conversationAgent,
		);
		let corrected: { id: string } | undefined;
		const host = {
			conversationAgent: {
				...f.host.conversationAgent,
				respond: (args: Parameters<typeof respond>[0]) =>
					respond({
						...args,
						tools: {
							...args.tools,
							async call(call, signal) {
								// The correction lands between the two reads of the same call.
								corrected = await saveItem(f.h.store, f.h.memory!, {
									conversationId: "ao",
									messageId: "user-b",
									kind: "preference",
									semanticKey: "drink",
									text: "朝はコーヒーをやめた",
								});
								return args.tools.call(call, signal);
							},
						},
					}),
			},
		};
		await replyWith(
			f,
			[{ name: "read_memory", arguments: { query: "コーヒー" } }],
			{
				runId: "run-read",
				messageIds: ["user-b"],
				hostTools: ["read_memory"],
				host,
			},
		);
		const given = f.h.store.read((db) =>
			f.host.dialoguePort.replyInputInTransaction!(db, "run-read"),
		);
		expect(corrected?.id).not.toBe(before.id);
		// The old version is superseded now: a reply that may have seen it rests on a stale memory and is refused.
		expect(given?.complete).toBe(false);
		expect(given?.sources).toContain(`memory:${corrected!.id}`);
	} finally {
		await f.close();
	}
});

test("read_memory's record reads with the dialogue domain's own limit", () => {
	const limits: number[] = [];
	const deps = {
		memory: {
			status: () => ({ enabled: true, healthy: true }),
			list: () => [],
			check: (input: { limit: number }) => {
				limits.push(input.limit);
				return { items: [], matched: 0 };
			},
		},
	} as unknown as AgencyHostDeps;
	readMemoryRefs(deps, "コーヒー", 0);
	expect(limits).toEqual([READ_MEMORY_LIMIT]);
});

const memoryOf = (count: number) =>
	Array.from({ length: count }, (_, i) => ({
		id: `item-${i}`,
		text: `記憶${i}`,
		polarity: "affirmed" as const,
		status: "active",
		validFromMs: null,
		validUntilMs: null,
	}));
const depsWith = (items: ReturnType<typeof memoryOf>) =>
	({
		memory: {
			status: () => ({ enabled: true, healthy: true }),
			// The memory lists the most recently updated item first.
			list: () => items,
		},
	}) as unknown as AgencyHostDeps;

test("a background call is given the most recently updated items up to the limit, and only those are recorded as seen", () => {
	const deps = depsWith(memoryOf(KNOWN_LIMIT + 3));
	const known = knownOf(deps, 0);
	expect(known).toHaveLength(KNOWN_LIMIT);
	expect(known.map((k) => k.id)).toEqual(
		memoryOf(KNOWN_LIMIT).map((item) => item.id),
	);
	expect(known.map((k) => k.id)).not.toContain(`item-${KNOWN_LIMIT}`);
	const scope = { agent: { view: () => ({ said: [] }) } } as never;
	const refs = seenRefs(deps, scope, 0);
	expect(refs).toEqual(known.map((k) => `memory:${k.id}`));
	// Fewer than the limit: all of them.
	expect(knownOf(depsWith(memoryOf(3)), 0)).toHaveLength(3);
});

test("the profile writer runs at once when none is running, with no wait", async () => {
	const f = await agendaFixture();
	try {
		await f.start();
		await f.user("user-a", "ao", "来月は箱根へ行く");
		await f.assistant("answer-a", "いいですね。");
		// No clock advance: the pass has already read the exchange.
		const [call] = f.calls("profile");
		expect(f.calls("profile")).toHaveLength(1);
		expect(call!.prompt).toContain("来月は箱根へ行く");
		await f.advance(60_000);
		expect(f.calls("profile")).toHaveLength(1);
	} finally {
		await f.close();
	}
});

test("replies that come in while the profile writer runs are read together by one pass right after it", async () => {
	let release!: () => void;
	const held = new Promise<void>((resolve) => (release = resolve));
	let profileCalls = 0;
	const f = await agendaFixture({
		script: async (kind: CallKind) => {
			if (kind !== "profile") return undefined;
			if (++profileCalls === 1) await held;
			return { ops: [] };
		},
	});
	try {
		await f.start();
		await f.user("user-a", "ao", "来月は箱根へ行く");
		await f.assistant("answer-a", "いいですね。");
		expect(f.calls("profile")).toHaveLength(1);
		await f.user("user-b", "ao", "紅葉も見たい");
		await f.assistant("answer-b", "素敵です。");
		await f.user("user-c", "ao", "温泉に入りたい");
		await f.assistant("answer-c", "いいですね。");
		// The first pass is still running: nothing else starts.
		expect(f.calls("profile")).toHaveLength(1);
		release();
		await settle();
		const calls = f.calls("profile");
		expect(calls).toHaveLength(2);
		// One pass for both exchanges that came in meanwhile.
		expect(calls[1]!.prompt).toContain("紅葉も見たい");
		expect(calls[1]!.prompt).toContain("温泉に入りたい");
		await settle();
		expect(f.calls("profile")).toHaveLength(2);
	} finally {
		await f.close();
	}
});

test("when nothing came in while the profile writer ran, it does not run again", async () => {
	let release!: () => void;
	const held = new Promise<void>((resolve) => (release = resolve));
	const f = await agendaFixture({
		script: async (kind: CallKind) => {
			if (kind !== "profile") return undefined;
			await held;
			return { ops: [] };
		},
	});
	try {
		await f.start();
		await f.user("user-a", "ao", "来月は箱根へ行く");
		await f.assistant("answer-a", "いいですね。");
		expect(f.calls("profile")).toHaveLength(1);
		release();
		await settle();
		await f.advance(60_000);
		expect(f.calls("profile")).toHaveLength(1);
	} finally {
		await f.close();
	}
});

test("words forgotten before the profile writer runs are not read by it", async () => {
	let release!: () => void;
	const held = new Promise<void>((resolve) => (release = resolve));
	const f = await agendaFixture({
		script: async (kind: CallKind) => {
			if (kind !== "profile") return undefined;
			await held;
			return { ops: [] };
		},
	});
	try {
		await f.start();
		await f.user("user-x", "ao", "最初の話題");
		await f.assistant("answer-x", "はい。");
		// The first pass is running; the next words queue behind it.
		await f.user("user-a", "ao", "秘密の旅行計画");
		await f.assistant("answer-a", "はい。");
		await f.user("user-b", "ao", "紅葉を見たい");
		await f.assistant("answer-b", "はい。");
		await f.h.memory!.forget({
			conversationId: "ao",
			messageIds: ["user-a"],
			itemIds: [],
		});
		release();
		await settle();
		const calls = f.calls("profile");
		expect(calls).toHaveLength(2);
		expect(calls[1]!.prompt).not.toContain("秘密の旅行計画");
		expect(calls[1]!.prompt).toContain("紅葉を見たい");
	} finally {
		await f.close();
	}
});

test("after the host is closed, a finished profile pass does not start another", async () => {
	let release!: () => void;
	const held = new Promise<void>((resolve) => (release = resolve));
	const f = await agendaFixture({
		script: async (kind: CallKind) => {
			if (kind !== "profile") return undefined;
			await held;
			return { ops: [] };
		},
	});
	try {
		await f.start();
		await f.user("user-a", "ao", "来月は箱根へ行く");
		await f.assistant("answer-a", "いいですね。");
		await f.user("user-b", "ao", "紅葉も見たい");
		await f.assistant("answer-b", "素敵です。");
		expect(f.calls("profile")).toHaveLength(1);
		await f.host.close();
		release();
		await settle();
		expect(f.calls("profile")).toHaveLength(1);
	} finally {
		await f.close();
	}
});

test("with no goal registered the goal host is not opened until a reply runs, and goal instructions/tools stay static in KV cache across registration", async () => {
	const conversation = goalConversation();
	const offered: Array<{ tools: string[]; system: string }> = [];
	const f = await agendaFixture({
		goals: { analysisMs: 30_000 },
		dialogue: {
			firstRound(tools, question, messages) {
				offered.push({
					tools: tools.map(({ function: tool }) => tool.name),
					system: messages[0]!.content,
				});
				return conversation.dialogue.firstRound!(tools, question, messages);
			},
		},
	});
	try {
		await f.start();
		await f.user("user-a");
		await f.advance(120_000);
		// Nothing was opened or polled for goals.
		expect(existsSync(join(f.h.dir, "goal-mock"))).toBe(false);
		await conversation.say(f, "こんにちは", []);
		const first = offered.at(-1)!;
		expect(first.tools).toEqual(
			expect.arrayContaining(["register_goal", "list_goals", "update_goal"]),
		);
		expect(first.system).toContain("register_goal");
		expect(first.system).toContain("authorize_mock");
		const quote = "目標を登録してください。README の実行例を直す。";
		const [registered] = await conversation.say(f, quote, [
			{
				name: "register_goal",
				args: {
					slot: null,
					desiredState: "README の実行例を直す。",
					priority: null,
					quote,
				},
			},
		]);
		expect(JSON.parse(registered!)).toMatchObject({ status: "registered" });
		await conversation.say(f, "目標の状態を教えて", []);
		const later = offered.at(-1)!;
		// Identical tools and system before and after registering a goal: KV cache is never invalidated.
		expect(later.tools).toEqual(first.tools);
		expect(later.system).toBe(first.system);
	} finally {
		await f.close();
	}
});

test("a commit that concerns nothing of the agent does not run the pump; the outbox and a forget do (the results of work are collected by the research tests)", async () => {
	const f = await agendaFixture();
	let original: typeof f.deps.conversation.changesInTransaction | undefined;
	try {
		await f.start();
		await f.user("user-a");
		await settle();
		let pumps = 0;
		original = f.deps.conversation.changesInTransaction;
		const read = original;
		f.deps.conversation.changesInTransaction = (...args) => {
			pumps++;
			return read(...args);
		};
		const commit = (sql: string) =>
			f.h.store.write((db) => {
				db.run(sql);
			});
		await commit("CREATE TABLE IF NOT EXISTS unrelated_noise (n INTEGER)");
		for (let i = 0; i < 3; i++) {
			await commit(`INSERT INTO unrelated_noise VALUES (${i})`);
			await settle();
		}
		expect(pumps).toBe(0);
		// The outbox moved: the words reach the agent.
		await f.user("user-b");
		expect(pumps).toBeGreaterThan(0);
		// A forget moves the conversation's epoch: the pump drops what rests on it.
		pumps = 0;
		await f.h.memory!.forget({
			conversationId: "ao",
			messageIds: ["user-a"],
			itemIds: [],
		});
		await settle();
		expect(pumps).toBeGreaterThan(0);
	} finally {
		if (original) f.deps.conversation.changesInTransaction = original;
		await f.close();
	}
});
