import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { settle, waitFor } from "../../infrastructure/wait-for";
import { createAgencyWork } from "./work";
import {
	choice,
	harness,
	type Harness,
	exchange,
	ledgerTodo,
	attachLedger,
} from "./host.fixture";

describe("TODOs offered to the agency", () => {
	test("open and asking TODOs reach the decision and the update, with the question; finished ones never do", async () => {
		const h = harness();
		const asked: string[] = [];
		h.host.attachWork(
			createAgencyWork({
				dialogue: {
					todosInTransaction: (_db, conversationId) => {
						asked.push(conversationId);
						return [
							ledgerTodo("open1", "todo"),
							ledgerTodo("ask1", "waiting", { question: "どの曲調ですか" }),
							ledgerTodo("done1", "done", { outcome: "succeeded" }),
						] as never;
					},
				},
			}),
		);
		await exchange(h, 1);
		await waitFor(() => h.calls.select === 1);
		const prompt = String(
			h.requests.find((r) => r.purpose === "select")?.prompt,
		);
		expect(asked).toContain("c1");
		expect(prompt).toContain("[todo:open1]");
		expect(prompt).toContain("仕事 ask1");
		expect(prompt).toContain("どの曲調ですか");
		expect(prompt).not.toContain("done1");
		const refresh = String(
			h.requests.find((r) => r.purpose === "update")?.prompt,
		);
		expect(refresh).toContain("どの曲調ですか");
		expect(refresh).not.toContain("done1");
	});

	test("a failing ledger read offers no TODOs and does not stop the cycle", async () => {
		const h = harness();
		h.host.attachWork(
			createAgencyWork({
				dialogue: {
					todosInTransaction: () => {
						throw new Error("ledger_unavailable");
					},
				},
			}),
		);
		await exchange(h, 1);
		await waitFor(() => h.calls.select === 1);
		expect(String(h.requests.at(-1)?.prompt ?? "")).not.toContain("[todo:");
	});
});

describe("asking what work asks", () => {
	const asking = () => [
		ledgerTodo("t1", "waiting", { question: "どの曲調ですか" }),
	];

	test("an utterance that cites an asking TODO is stored with its todoRefs", async () => {
		const h = harness({
			select: () =>
				choice("speak", {
					utterance: "どの曲調にしますか。",
					refs: ["todo:t1"],
				}),
		});
		attachLedger(h, asking);
		await exchange(h, 1);
		await waitFor(() => h.texts().length === 3);
		expect(h.spoke).toHaveLength(1);
		expect(h.spoke[0]).toMatchObject({
			conversationId: "c1",
			text: "どの曲調にしますか。",
			todoRefs: ["t1"],
		});
		expect(h.spoke[0]!.messageId).toBe(h.texts()[2]);
	});

	test("an utterance that cites no TODO carries no todoRefs", async () => {
		const h = harness({ select: () => choice("speak", { refs: ["u1"] }) });
		attachLedger(h, asking);
		await exchange(h, 1);
		await waitFor(() => h.texts().length === 3);
		expect(h.spoke).toHaveLength(1);
		expect(h.spoke[0]).not.toHaveProperty("todoRefs");
	});
});

describe("work that changed", () => {
	/** The transaction that records a work change: the dialogue writes the ledger in it, here a stand-in row. */
	const change = (db: Database, h: Harness, id: string) => {
		db.run("CREATE TABLE IF NOT EXISTS work_stand_in (n INTEGER)");
		db.run("INSERT INTO work_stand_in VALUES (1)");
		h.host.dialoguePort.workChangedInTransaction(db, id);
	};
	const changed = (h: Harness, id = "c1") =>
		h.store.write((db) => change(db, h, id));
	/** A TODO that asks a question once `ask` is called. */
	const asking = (h: Harness) => {
		let asked = false;
		attachLedger(h, () =>
			asked
				? [ledgerTodo("t1", "waiting", { question: "どの曲調ですか" })]
				: [],
		);
		return () => {
			asked = true;
		};
	};

	test("a question opens a result_received opportunity after the commit, in the conversation the user is in", async () => {
		const h = harness();
		const ask = asking(h);
		await exchange(h, 1);
		await waitFor(() => h.calls.select === 1);
		await settle();
		ask();
		// The background calls keep their minimum interval.
		h.advanceClock(60_000);
		await h.store.write((db) => {
			change(db, h, "c1");
			// Nothing happens inside the transaction: it may still roll back.
			expect(h.calls.select).toBe(1);
		});
		await waitFor(() => h.calls.select === 2);
		const prompt = String(
			h.requests.filter((r) => r.purpose === "select").at(-1)?.prompt,
		);
		expect(prompt).toContain("trigger=result_received");
		// The update reads new observations, and there are none: only the decision is asked.
		expect(h.calls.update).toBe(1);
		// The same question told again opens nothing more.
		h.advanceClock(60_000);
		await changed(h);
		await settle();
		expect(h.calls.select).toBe(2);
	});

	test("finished work opens no opportunity: its notice on screen tells it", async () => {
		const h = harness();
		let done = false;
		attachLedger(h, () =>
			done ? [ledgerTodo("t1", "done", { outcome: "succeeded" })] : [],
		);
		await exchange(h, 1);
		await waitFor(() => h.calls.select === 1);
		await settle();
		done = true;
		h.advanceClock(60_000);
		await changed(h);
		await settle();
		expect(h.calls.select).toBe(1);
	});

	test("a change told in a transaction that rolled back opens nothing", async () => {
		const h = harness();
		asking(h)();
		await exchange(h, 1);
		await waitFor(() => h.calls.select === 1);
		await settle();
		h.advanceClock(60_000);
		await expect(
			h.store.write((db) => {
				change(db, h, "c1");
				throw new Error("rolled_back");
			}),
		).rejects.toThrow("rolled_back");
		// The next commit of anything opens no opportunity: no TODO changed.
		await h.store.write((db) => {
			db.run("CREATE TABLE IF NOT EXISTS work_stand_in (n INTEGER)");
			db.run("INSERT INTO work_stand_in VALUES (1)");
		});
		await settle();
		expect(h.calls.select).toBe(1);
	});

	test("in a conversation the user is not in, it waits for the next turn there", async () => {
		const h = harness();
		const ask = asking(h);
		await exchange(h, 1, "c1");
		await waitFor(() => h.calls.select === 1);
		await exchange(h, 2, "c2");
		await waitFor(() => h.calls.select === 2);
		await settle();
		ask();
		h.advanceClock(60_000);
		await changed(h, "c1");
		await settle();
		expect(h.calls.select).toBe(2);
		// The user speaks in c1 again; the question is asked as part of that turn's own opportunity.
		await exchange(h, 3, "c1");
		await waitFor(() => h.calls.select === 3);
	});

	test("the question the opportunity asks is delivered as a runless message citing it", async () => {
		const h = harness({
			select: (request) =>
				String(request.prompt).includes("trigger=result_received")
					? choice("speak", {
							utterance: "どの曲調にしますか。",
							refs: ["todo:t1"],
						})
					: choice("wait"),
		});
		const ask = asking(h);
		await exchange(h, 1);
		await waitFor(() => h.calls.select === 1);
		await settle();
		ask();
		h.advanceClock(60_000);
		await changed(h);
		await waitFor(() => h.texts().length === 3);
		expect(h.conversation.get("c1").messages[2]).toMatchObject({
			role: "assistant",
			runId: null,
			text: "どの曲調にしますか。",
		});
		expect(h.spoke.at(-1)).toMatchObject({ todoRefs: ["t1"] });
	});
});

describe("the conversation agent", () => {
	const chatOf = (replies: Array<{ text: string; calls?: string[] }>) => {
		const seen: unknown[] = [];
		let turn = 0;
		return {
			seen,
			chat: {
				async complete(
					request: { messages: unknown[]; tools: unknown[] },
					onDelta: (text: string) => void,
				) {
					seen.push(request);
					const reply = replies[turn++]!;
					onDelta(reply.text);
					return {
						text: reply.text,
						toolCalls: (reply.calls ?? []).map((name, index) => ({
							id: `call-${turn}-${index}`,
							name,
							arguments: "{}",
						})),
					};
				},
			},
		};
	};
	const tools = (
		call: (name: string) => { content: string; end?: boolean } = () => ({
			content: "{}",
		}),
	) => ({
		tools: [{ name: "find_toolchain", description: "d", parameters: {} }],
		call: async (c: { name: string }) => call(c.name),
	});
	const reply = (
		h: Harness,
		replies: Array<{ text: string; calls?: string[] }>,
		toolPort = tools(),
	) => {
		const spoken: string[] = [];
		const script = chatOf(replies);
		return h.host.conversationAgent
			.respond({
				messages: [
					{ role: "system", content: "SYSTEM" },
					{ role: "user", content: "こんにちは" },
				],
				chat: script.chat,
				tools: toolPort,
				signal: new AbortController().signal,
				onDelta: (text) => spoken.push(text),
				maxToolCalls: 6,
			})
			.then((result) => ({ result, spoken, script }));
	};

	test("the system parts are fixed by the settings: the interests and the spoken style, and the feeling rule only when the feeling is on", () => {
		const plain = harness({ settings: { interests: ["My Melody"] } });
		const system = plain.host.conversationAgent.system();
		expect(system.persona).toContain("My Melody");
		expect(system.spokenReplyStyle).toBeDefined();
		expect(system.emotionRules).toBeUndefined();
		// The same settings give the same parts, so the cached prefix holds.
		expect(plain.host.conversationAgent.system()).toEqual(system);
		const feeling = harness({
			settings: { interests: ["My Melody"], emotion: true },
		});
		expect(feeling.host.conversationAgent.system().emotionRules).toBeDefined();
	});

	test("a reply is one model call that answers in plain text", async () => {
		const h = harness();
		const { result, spoken, script } = await reply(h, [
			{ text: "こんにちは。" },
		]);
		expect(result).toEqual({ text: "こんにちは。", ended: false });
		expect(spoken.join("")).toBe("こんにちは。");
		expect(script.seen).toHaveLength(1);
	});

	test("the leading feeling emoji becomes the delivery emotion and is not spoken; calm is none", async () => {
		const h = harness({ settings: { emotion: true } });
		const joy = await reply(h, [{ text: "😊いい天気ですね。" }]);
		expect(joy.result).toEqual({
			text: "いい天気ですね。",
			emotion: "joy",
			ended: false,
		});
		expect(joy.spoken.join("")).toBe("いい天気ですね。");
		const calm = await reply(h, [{ text: "🙂わかりました。" }]);
		expect(calm.result).toMatchObject({
			text: "わかりました。",
			emotion: "none",
		});
	});

	test("with the feeling off the reply is left as it is and carries no emotion", async () => {
		const h = harness();
		const { result } = await reply(h, [{ text: "😊いい天気ですね。" }]);
		expect(result.emotion).toBeUndefined();
		expect(result.text).toContain("いい天気ですね。");
	});

	test("a tool call runs through the host's tools and the reply goes on with its result", async () => {
		const h = harness();
		const ran: string[] = [];
		const { result, script } = await reply(
			h,
			[
				{ text: "探します。", calls: ["find_toolchain"] },
				{ text: "見つかりませんでした。" },
			],
			tools((name) => {
				ran.push(name);
				return { content: '{"candidates":[]}' };
			}),
		);
		expect(ran).toEqual(["find_toolchain"]);
		expect(result.ended).toBe(false);
		// The preamble is spoken, and the answer after the tool's result follows it.
		expect(result.text).toBe("探します。見つかりませんでした。");
		expect(script.seen).toHaveLength(2);
	});

	test("a tool that hands the work over ends the reply", async () => {
		const h = harness();
		const { result, script } = await reply(
			h,
			[{ text: "調べます。", calls: ["find_toolchain"] }],
			tools(() => ({ content: '{"delegated":true}', end: true })),
		);
		expect(result.ended).toBe(true);
		expect(script.seen).toHaveLength(1);
	});
});
