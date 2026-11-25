import { expect, test } from "bun:test";
import {
	ask,
	assignmentAgenda,
	card,
	items,
	notes,
	reportLine,
	until,
	works,
} from "../media/assignment.fixture";

const NOTE = [
	"題: PETGフィラメントの保管",
	"要約: 防湿容器に乾燥剤と一緒に入れて保管し、湿ったら乾燥機で乾かす。",
	"---",
	"## 保管と乾燥（2026年11月時点）",
	"密閉できる容器に乾燥剤を入れる。乾燥は65℃前後で4〜6時間が目安。",
	"## 出典",
	"- [メーカーの案内](https://example.com/petg)",
].join("\n");

test("a single lookup is the agent's assignment to the web note task, never to the withdrawn Web search, and its note is adopted with its sources", async () => {
	const request = "PETGフィラメントの吸湿を防ぐ保管方法を調べてまとめて";
	const prompts: string[] = [];
	const a = await assignmentAgenda({
		harness: {
			webNote: {
				turn: async (call) => {
					prompts.push(call.prompt);
					return {
						text: NOTE,
						searches: 2,
						usage: {
							input: 25_000,
							cachedInput: 0,
							output: 800,
							reasoning: 100,
						},
					};
				},
			},
		},
	});
	const h = a.h;
	try {
		await a.start();
		expect(() => card(a, "web.search")).toThrow("fixture_toolchain_missing");
		const { source } = await ask(a, "web.note", request);
		await until(a, () => notes(a).length === 1);
		await until(a, () => !!reportLine(a));
		// The user's words started one web note execution at its owner; the search never ran.
		expect(works(a).map((w) => w.toolchain_revision_id.split("@")[0])).toEqual([
			"toolchain:web.note",
		]);
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain(`依頼:\n${request}`);
		const runs = () =>
			h.store.read((db) =>
				db
					.query<{ id: string; state: string }, []>(
						"SELECT id,state FROM web_note_runs",
					)
					.all(),
			);
		expect(runs()).toEqual([{ id: expect.any(String), state: "completed" }]);
		// The agent reports with a work report note: the request and what the work answered.
		const [note] = notes(a);
		expect(note!.title).toBe(`作業報告: ${request}`);
		expect(note!.markdown).toContain(`## 依頼\n\n${request}`);
		expect(note!.markdown).toContain(
			"防湿容器に乾燥剤と一緒に入れて保管し、湿ったら乾燥機で乾かす。",
		);
		expect(source.request).toBe(request);
		expect(items(a)).toHaveLength(0);
		const main = await (await h.request("/api/conversations/main")).json();
		expect(main.messages).toEqual([]);
	} finally {
		await a.close();
	}
}, 30_000);
