import { expect, test } from "bun:test";
import { estimateTextTokens } from "../../../infrastructure/context-budget";
import { formatResourceUri, parseResourceUri } from "../../resources";
import { createKanbanResourceAdapter } from "..";
import { openKanban } from "./kanban.fixture";

const signal = new AbortController().signal;
const idOf = (uri: string) => parseResourceUri(uri)?.id;

async function setup() {
	const { store, kanban } = openKanban();
	const adapter = createKanbanResourceAdapter({ store });
	let n = 0;
	const add = async (title: string, prompt = `${title} の依頼`) =>
		(
			await store.write((tx) =>
				kanban.addInTransaction(tx, { title, prompt }, `req-${++n}`),
			)
		).receipt.cardId;
	return { store, adapter, add };
}

test("a card receipt or ref becomes a code.task ref with the kanban prefix; board refs and unknown cards do not", async () => {
	const { store, adapter, add } = await setup();
	const card = await add("READMEの手順修正");
	const read = (result: unknown) =>
		store.read((db) =>
			adapter.fromResultInTransaction(db, result, { conversationId: "main" }),
		);
	const expected = [
		{
			uri: formatResourceUri("code.task", `kanban:${card}`),
			kind: "code.task",
			label: "READMEの手順修正",
			createdAt: expect.any(String),
		},
	];
	expect(read({ receipt: { cardId: card, revision: 1 } })).toEqual(expected);
	expect(
		read({
			receipt: { cardId: card },
			resultRefs: [{ owner: "kanban", kind: "card", id: card }],
		}),
	).toEqual(expected);
	expect(
		read({ resultRefs: [{ owner: "kanban", kind: "board", id: "board" }] }),
	).toEqual([]);
	expect(
		read({ resultRefs: [{ owner: "pipelines", kind: "card", id: card }] }),
	).toEqual([]);
	expect(read({ receipt: { cardId: "no-such-card" } })).toEqual([]);
	expect(read(undefined)).toEqual([]);
});

test("get: the board screen with the card as target; other prefixes, bare ids and missing cards are null", async () => {
	const { store, adapter, add } = await setup();
	const card = await add("A");
	const views = store.read((db) => [
		adapter.getInTransaction(db, `kanban:${card}`),
		adapter.getInTransaction(db, card),
		adapter.getInTransaction(db, `codex:${card}`),
		adapter.getInTransaction(db, `shell:${card}`),
		adapter.getInTransaction(db, "kanban:"),
		adapter.getInTransaction(db, "kanban:missing"),
	]);
	expect(views[0]).toMatchObject({
		uri: formatResourceUri("code.task", `kanban:${card}`),
		adapterRef: "adapter:kanban@2",
		targetRef: card,
		actions: ["open", "read"],
		preview: "未着手",
	});
	expect(views.slice(1).every((v) => v === null)).toBe(true);
});

test("search matches title, request and report, newest first, with limit and period", async () => {
	const { store, adapter, add } = await setup();
	const a = await add("認証の修正", "ログインを直す");
	const b = await add("README更新", "手順を書く");
	const c = await add("検索の改善", "ログイン後の検索");
	await store.write((db) =>
		db
			.query("UPDATE kanban_cards SET last_report=? WHERE id=?")
			.run("原因は期限切れのトークン", b),
	);
	const find = async (text: string, extra = {}) =>
		(await adapter.search({ text, limit: 10, ...extra }, signal)).map((r) =>
			idOf(r.uri),
		);
	expect(await find("")).toEqual([`kanban:${c}`, `kanban:${b}`, `kanban:${a}`]);
	expect(await find("ログイン")).toEqual([`kanban:${c}`, `kanban:${a}`]);
	expect(await find("トークン")).toEqual([`kanban:${b}`]);
	expect(await find("ログイン 検索")).toEqual([`kanban:${c}`]);
	expect(await find("存在しない")).toEqual([]);
	expect((await adapter.search({ text: "", limit: 2 }, signal)).length).toBe(2);
	const created = await store.read(
		(db) =>
			db
				.query("SELECT id, created_at FROM kanban_cards ORDER BY created_at")
				.all() as Array<{
				id: string;
				created_at: number;
			}>,
	);
	const middle = created.find((row) => row.id === b)!;
	expect(
		await find("", {
			since: new Date(middle.created_at).toISOString(),
			until: new Date(middle.created_at).toISOString(),
		}),
	).toEqual([`kanban:${b}`]);
});

test("read stays within 600 tokens and shows the request, status and report; foreign ids are refused", async () => {
	const { store, adapter, add } = await setup();
	const card = await add("長い作業", "依頼文。".repeat(500));
	await store.write((db) =>
		db
			.query("UPDATE kanban_cards SET last_report=?, files_json=? WHERE id=?")
			.run("報告です。".repeat(500), JSON.stringify(["a.ts", "b.ts"]), card),
	);
	await store.write((db) =>
		db
			.query(
				`INSERT INTO kanban_runs(id,card_id,executor_id,executor_revision,workspace_ref,kind,state,card_revision,title,prompt,body,claude_session_id,project_id,origin,created_at)
 VALUES('run-1',?,'x',1,'eumenes','task','completed',1,'長い作業','p','b','s','eumenes','board',1)`,
			)
			.run(card),
	);
	const text = (await adapter.read(`kanban:${card}`, signal)).text;
	expect(text).toContain("実行: 1回、直近はtask（completed）");
	expect(text).toContain("コード作業: 長い作業");
	expect(text).toContain("状態: 未着手");
	expect(text).toContain("依頼:");
	expect(text).toContain("報告:");
	expect(estimateTextTokens(text)).toBeLessThanOrEqual(600);
	await expect(adapter.read(card, signal)).rejects.toThrow("item_not_found");
	await expect(adapter.read(`codex:${card}`, signal)).rejects.toThrow(
		"item_not_found",
	);
	await expect(adapter.read("kanban:missing", signal)).rejects.toThrow(
		"item_not_found",
	);
});
