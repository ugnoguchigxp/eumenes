import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateTextTokens } from "../../../infrastructure/context-budget";
import { openStore, type SqliteStore } from "../../../infrastructure/sqlite";
import { formatResourceUri, parseResourceUri } from "../../resources";
import {
	createCodexTasks,
	createCodexTasksResourceAdapter,
	migrations,
} from "..";
import type { CodexEnqueue } from "../contracts";

const stores: SqliteStore[] = [];
const dirs: string[] = [];
afterEach(async () => {
	for (const store of stores.splice(0)) await store.close();
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
const signal = new AbortController().signal;
const idOf = (uri: string) => parseResourceUri(uri)?.id;

function setup() {
	const dir = mkdtempSync(join(tmpdir(), "codex-resource-"));
	dirs.push(dir);
	const store = openStore(join(dir, "db.sqlite"), [
		{ id: "queue/0001-init", sql: "SELECT 1" },
		...migrations,
	]);
	stores.push(store);
	let clock = Date.UTC(2026, 9, 20);
	const service = createCodexTasks({ store, now: () => (clock += 1000) });
	const adapter = createCodexTasksResourceAdapter({ store });
	const enqueue = (runId: string, cardId: string, prompt: string) =>
		store.write((db) =>
			service.enqueueInTransaction(db, {
				scope: "shared-board",
				cardId,
				runId,
				requestId: `request-${runId}`,
				runnerId: "runner",
				executorRevision: 1,
				workspaceRef: "shared",
				guardEpoch: "guard-epoch",
				workerRevision: "profile:fixture-worker@1",
				settingsRevision: 1,
				spec: {
					protocol: "eumenes-codex-sdk/1",
					executionId: runId,
					ownerId: cardId,
					workspaceId: "fixture",
					prompt,
					deadline: new Date(Date.now() + 60_000).toISOString(),
				},
			} satisfies CodexEnqueue),
		);
	return { store, adapter, enqueue };
}

test("only a result naming one of this owner's attempts becomes a ref; a kanban card receipt is not claimed", async () => {
	const { store, adapter, enqueue } = setup();
	await enqueue("attempt-1", "card-1", "READMEを直す");
	const read = (result: unknown) =>
		store.read((db) =>
			adapter.fromResultInTransaction(db, result, { conversationId: "main" }),
		);
	expect(
		read({
			resultRefs: [
				{ owner: "codex-tasks", kind: "attempt", id: "attempt-1" },
				{ owner: "codex-tasks", kind: "attempt", id: "attempt-1" },
			],
		}),
	).toEqual([
		{
			uri: formatResourceUri("code.task", "codex:attempt-1"),
			kind: "code.task",
			label: "READMEを直す",
			createdAt: expect.any(String),
		},
	]);
	expect(
		read({ resultRefs: [{ owner: "kanban", kind: "card", id: "card-1" }] }),
	).toEqual([]);
	expect(
		read({
			resultRefs: [{ owner: "codex-tasks", kind: "attempt", id: "nope" }],
		}),
	).toEqual([]);
	expect(read({ receipt: { cardId: "card-1" } })).toEqual([]);
	expect(read(null)).toEqual([]);
});

test("get: the board card as the target; other prefixes, bare ids and missing attempts are null", async () => {
	const { store, adapter, enqueue } = setup();
	await enqueue("attempt-1", "card-1", "READMEを直す\n詳細");
	const views = store.read((db) => [
		adapter.getInTransaction(db, "codex:attempt-1"),
		adapter.getInTransaction(db, "attempt-1"),
		adapter.getInTransaction(db, "kanban:attempt-1"),
		adapter.getInTransaction(db, "shell:attempt-1"),
		adapter.getInTransaction(db, "codex:"),
		adapter.getInTransaction(db, "codex:nope"),
	]);
	expect(views[0]).toMatchObject({
		uri: formatResourceUri("code.task", "codex:attempt-1"),
		label: "READMEを直す",
		adapterRef: "adapter:kanban@2",
		targetRef: "card-1",
		actions: ["open", "read"],
		preview: "受付済み",
	});
	expect(views.slice(1).every((v) => v === null)).toBe(true);
});

test("search matches the request and the report, newest first, with limit and period", async () => {
	const { store, adapter, enqueue } = setup();
	await enqueue("attempt-1", "card-1", "ログイン画面を直す");
	await enqueue("attempt-2", "card-2", "READMEを直す");
	await enqueue("attempt-3", "card-1", "ログインの続き");
	await store.write((db) =>
		db
			.query(
				"UPDATE codex_task_attempts SET receipt_json=? WHERE id='attempt-2'",
			)
			.run(
				JSON.stringify({
					report: {
						outcome: "done",
						summary: "トークンの期限を修正",
						verification: [],
						files: [],
						unconfirmed: [],
						blocker: "",
					},
				}),
			),
	);
	const find = async (text: string, extra = {}) =>
		(await adapter.search({ text, limit: 10, ...extra }, signal)).map((r) =>
			idOf(r.uri),
		);
	expect(await find("")).toEqual([
		"codex:attempt-3",
		"codex:attempt-2",
		"codex:attempt-1",
	]);
	expect(await find("ログイン")).toEqual([
		"codex:attempt-3",
		"codex:attempt-1",
	]);
	expect(await find("トークン")).toEqual(["codex:attempt-2"]);
	expect(await find("ログイン 続き")).toEqual(["codex:attempt-3"]);
	expect(await find("存在しない")).toEqual([]);
	expect((await adapter.search({ text: "", limit: 1 }, signal)).length).toBe(1);
	const second = (
		await adapter.search({ text: "README", limit: 10 }, signal)
	)[0]!;
	expect(
		await find("", { since: second.createdAt, until: second.createdAt }),
	).toEqual(["codex:attempt-2"]);
});

test("read shows the request and the report within 600 tokens; foreign ids are refused", async () => {
	const { store, adapter, enqueue } = setup();
	await enqueue("attempt-1", "card-1", "長い依頼。".repeat(500));
	await store.write((db) =>
		db
			.query(
				"UPDATE codex_task_attempts SET state='succeeded', receipt_json=? WHERE id='attempt-1'",
			)
			.run(
				JSON.stringify({
					report: {
						outcome: "done",
						summary: "報告です。".repeat(500),
						verification: ["bun test"],
						files: ["a.ts"],
						unconfirmed: [],
						blocker: "",
					},
				}),
			),
	);
	const text = (await adapter.read("codex:attempt-1", signal)).text;
	expect(text).toContain("状態: 完了");
	expect(text).toContain("依頼:");
	expect(text).toContain("報告:");
	expect(estimateTextTokens(text)).toBeLessThanOrEqual(600);
	await expect(adapter.read("attempt-1", signal)).rejects.toThrow(
		"item_not_found",
	);
	await expect(adapter.read("kanban:attempt-1", signal)).rejects.toThrow(
		"item_not_found",
	);
	await expect(adapter.read("codex:nope", signal)).rejects.toThrow(
		"item_not_found",
	);
});
