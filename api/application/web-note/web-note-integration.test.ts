import { expect, test } from "bun:test";
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
		withdrawnWebSearch: true,
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
			conversationId: "main",
			text: request,
		});
		await waitFor(() => h.dialogue.get(source.id)?.status === "completed");
		await waitFor(() => h.reported().includes("PETGフィラメントの保管"), {
			timeout: 10000,
		});
		expect(offered).toContain("web.note");
		expect(offered).not.toContain("web.search");
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain(`依頼:\n${request}`);
		expect(JSON.parse(h.reported())).toMatchObject({
			status: "completed",
			title: "PETGフィラメントの保管",
			summary: expect.stringContaining("乾燥剤"),
			answer: expect.stringContaining("65℃前後"),
			sources: [{ url: "https://example.com/petg", title: "メーカーの案内" }],
		});
		// The notice was sent; the conversation's run for it acknowledges it, which recovery records.
		const runs = () =>
			h.store.read((db) =>
				db.query("SELECT state,notice FROM web_note_runs").all(),
			);
		expect(runs()).toEqual([{ state: "completed", notice: "accepted" }]);
		await waitFor(async () => {
			await h.toolchain.webNote.recover();
			return (runs() as Array<{ notice: string }>)[0]!.notice === "delivered";
		});
		// A lookup is answered in the conversation, not announced as a finished external work.
		const notices = await (await h.request("/api/todo-notices")).json();
		expect(notices).toEqual({ notices: [], unread: 0 });
	} finally {
		await h.close();
	}
}, 30_000);
