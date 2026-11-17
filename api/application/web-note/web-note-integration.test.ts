import { expect, test } from "bun:test";
import { conversationSchema } from "../../domains/conversation/contracts";
import { harness } from "../toolchain/toolchain.fixture";
import { searchThenDelegate } from "../toolchain/conversation-script.fixture";
import { waitFor } from "../../infrastructure/wait-for";

const NOTE = [
	"題: PETGフィラメントの保管",
	"要約: 防湿容器に乾燥剤と一緒に入れて保管し、湿ったら乾燥機で乾かす。",
	"---",
	"## 保管と乾燥（2026年11月時点）",
	"密閉できる容器に乾燥剤を入れる。乾燥は65℃前後で4〜6時間が目安。",
	"## 出典",
	"- [メーカーの案内](https://example.com/petg)",
].join("\n");

test("a single lookup from the conversation is handed to the web note task, never to the withdrawn Web search, and its note is adopted with its sources", async () => {
	const request = "PETGフィラメントの吸湿を防ぐ保管方法を調べてまとめて";
	const offered: string[] = [];
	const prompts: string[] = [];
	const h = await harness({
		webNote: {
			turn: async (call) => {
				prompts.push(call.prompt);
				return {
					text: NOTE,
					searches: 2,
					usage: { input: 25_000, cachedInput: 0, output: 800, reasoning: 100 },
				};
			},
		},
		discoveryTarget: () => "web_note",
		firstRound: (_tools, _question, messages) =>
			searchThenDelegate(
				(c) => {
					offered.push(c.id);
					return c.id === "web.note";
				},
				request,
				{ impact: "none", announcement: "調べます。" },
			)(messages),
	});
	try {
		const source = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "research-request",
			text: request,
		});
		await waitFor(() => h.dialogue.get(source.id)?.status === "completed");
		await waitFor(
			() => h.reported("research-request").includes("PETGフィラメントの保管"),
			{
				timeout: 10000,
			},
		);
		expect(offered).toContain("web.note");
		expect(offered).not.toContain("web.search");
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain(`依頼:\n${request}`);
		expect(JSON.parse(h.reported("research-request"))).toMatchObject({
			status: "completed",
			title: "PETGフィラメントの保管",
			summary: expect.stringContaining("乾燥剤"),
			answer: "防湿容器に乾燥剤と一緒に入れて保管し、湿ったら乾燥機で乾かす。",
			sources: [{ url: "https://example.com/petg", title: "メーカーの案内" }],
		});
		// The notice was sent; the conversation's run for it acknowledges it, which recovery records.
		const runs = () =>
			h.store.read((db) =>
				db
					.query<{ id: string; state: string; notice: string }, []>(
						"SELECT id,state,notice FROM web_note_runs",
					)
					.all(),
			);
		expect(runs()).toEqual([
			{ id: expect.any(String), state: "completed", notice: "accepted" },
		]);
		const noteId = runs()[0]!.id;
		const saved = h.store.read((db) =>
			h.toolchain.webNote.task.viewInTransaction(db, noteId),
		);
		expect(saved?.result?.answer).toContain("65℃前後");
		await waitFor(async () => {
			await h.toolchain.webNote.recover();
			return runs()[0]?.notice === "delivered";
		});
		// A lookup is answered in the conversation, not announced as a finished external work.
		const notices = await (await h.request("/api/todo-notices")).json();
		expect(notices).toEqual({ notices: [], unread: 0 });
		const conversation = conversationSchema.parse(
			await (await h.request("/api/conversations/research-request")).json(),
		);
		const replies = conversation.messages.filter(
			(message) =>
				message.role === "assistant" &&
				message.displayText?.includes("PETGフィラメントの保管"),
		);
		expect(replies).toEqual([
			expect.objectContaining({
				text: "防湿容器に乾燥剤と一緒に入れて保管し、湿ったら乾燥機で乾かす。",
				displayText: expect.stringContaining(
					"[メーカーの案内](https://example.com/petg)",
				),
			}),
		]);
		expect(replies[0]?.displayText).toContain("65℃前後");
		const main = await (await h.request("/api/conversations/main")).json();
		expect(main.messages).toEqual([]);
	} finally {
		await h.close();
	}
}, 30_000);
