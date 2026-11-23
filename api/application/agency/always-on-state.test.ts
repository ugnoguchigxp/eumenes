import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { saveItem } from "../../domains/memory/test/memory.fixture";
import { settle } from "../../infrastructure/wait-for";
import { READ_MEMORY_LIMIT } from "../../domains/dialogue";
import { readMemoryRefs } from "./always-on-scope";
import { agendaFixture, replyWith } from "./always-on.fixture";
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
			recall: (input: { limit: number }) => {
				limits.push(input.limit);
				return { total: 0, items: [], matched: 0 };
			},
		},
	} as unknown as AgencyHostDeps;
	readMemoryRefs(deps, "コーヒー", 0);
	expect(limits).toEqual([READ_MEMORY_LIMIT]);
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
