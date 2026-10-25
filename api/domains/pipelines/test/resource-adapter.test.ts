import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateTextTokens } from "../../../infrastructure/context-budget";
import { openStore } from "../../../infrastructure/sqlite";
import { formatResourceUri, parseResourceUri } from "../../resources";
import {
	commitDocumentInTransaction,
	createPipelinesResourceAdapter,
	endWorkInTransaction,
	migrations,
	openWorkInTransaction,
	recordPublishedInTransaction,
} from "..";
import { cookTimerMusic } from "./pipeline.fixture";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const c of cleanup.splice(0)) await c();
});
function setup() {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-pipelines-resource-"));
	const store = openStore(join(dir, "db"), [
		{ id: "queue/0001-init", sql: "SELECT 1" },
		...migrations,
	]);
	cleanup.push(async () => {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	return { store, adapter: createPipelinesResourceAdapter({ store }) };
}
const signal = new AbortController().signal;
const idOf = (uri: string) => parseResourceUri(uri)?.id;

test("a drafted or published receipt becomes a pipeline ref; a rejected one and other owners do not", async () => {
	const { store, adapter } = setup();
	const work = await store.write((db) => {
		const opened = openWorkInTransaction(db, { sessionId: "s1", target: null });
		commitDocumentInTransaction(db, { kind: "ui" }, opened.workRef, {
			baseRevision: 0,
			definition: cookTimerMusic,
		});
		recordPublishedInTransaction(
			db,
			{ workRef: opened.workRef, toolchainId: "cook-timer-music" },
			"req-1",
			"digest",
		);
		return opened.workRef;
	});
	const read = (result: unknown) =>
		store.read((db) =>
			adapter.fromResultInTransaction(db, result, { conversationId: "main" }),
		);
	const expected = [
		{
			uri: formatResourceUri("pipeline", work),
			kind: "pipeline",
			label: cookTimerMusic.title,
			createdAt: expect.any(String),
		},
	];
	expect(read({ workRef: work, state: "drafted", revision: 1 })).toEqual(
		expected,
	);
	expect(
		read({
			receipt: {
				workRef: work,
				state: "published",
				revision: 1,
				toolchainId: "cook-timer-music",
			},
			resultRefs: [
				{ owner: "pipelines", kind: "pipeline", id: "cook-timer-music" },
				{ owner: "pipelines", kind: "pipeline-work", id: work },
			],
		}),
	).toEqual(expected);
	expect(read({ workRef: work, state: "rejected", revision: 1 })).toEqual([]);
	expect(
		read({ resultRefs: [{ owner: "kanban", kind: "card", id: work }] }),
	).toEqual([]);
	expect(read({ workRef: "no-such-work", state: "drafted" })).toEqual([]);
	expect(read(null)).toEqual([]);
});

test("get: studio screen, the published toolchain as target; a draft never published has an empty target; missing is null", async () => {
	const { store, adapter } = setup();
	const [published, draft] = await store.write((db) => {
		const a = openWorkInTransaction(db, { sessionId: "s1", target: null });
		commitDocumentInTransaction(db, { kind: "ui" }, a.workRef, {
			baseRevision: 0,
			definition: cookTimerMusic,
		});
		recordPublishedInTransaction(
			db,
			{ workRef: a.workRef, toolchainId: "cook-timer-music" },
			"req-1",
			"digest",
		);
		const b = openWorkInTransaction(db, { sessionId: "s2", target: null });
		return [a.workRef, b.workRef];
	});
	const views = store.read((db) => [
		adapter.getInTransaction(db, published!),
		adapter.getInTransaction(db, draft!),
		adapter.getInTransaction(db, "nope"),
		adapter.getInTransaction(db, "codex:nope"),
	]);
	expect(views[0]).toMatchObject({
		adapterRef: "adapter:pipelines@1",
		targetRef: "cook-timer-music",
		actions: ["open", "read"],
		label: cookTimerMusic.title,
		preview: cookTimerMusic.summary.slice(0, 80),
	});
	expect(views[1]).toMatchObject({
		adapterRef: "adapter:pipelines@1",
		targetRef: "",
		label: "新しいパイプライン",
	});
	expect(views[2]).toBeNull();
	expect(views[3]).toBeNull();
});

test("a closed work is gone from get, search and read", async () => {
	const { store, adapter } = setup();
	const work = await store.write((db) => {
		const a = openWorkInTransaction(db, { sessionId: "s1", target: null });
		commitDocumentInTransaction(db, { kind: "ui" }, a.workRef, {
			baseRevision: 0,
			definition: cookTimerMusic,
		});
		return a.workRef;
	});
	await store.write((db) => endWorkInTransaction(db, work, "discard"));
	expect(store.read((db) => adapter.getInTransaction(db, work))).toBeNull();
	expect(await adapter.search({ text: "", limit: 10 }, signal)).toEqual([]);
	await expect(adapter.read(work, signal)).rejects.toThrow("item_not_found");
});

test("search matches title and definition text, newest first, with limit and period", async () => {
	const { store, adapter } = setup();
	const ids = await store.write((db) => {
		const make = (
			session: string,
			title: string,
			definition?: typeof cookTimerMusic,
		) => {
			const w = openWorkInTransaction(db, { sessionId: session, target: null });
			if (definition)
				commitDocumentInTransaction(db, { kind: "ui" }, w.workRef, {
					baseRevision: 0,
					definition,
					title,
				});
			return w.workRef;
		};
		const first = make("s1", "茹で時間", cookTimerMusic);
		const second = make("s2", "無関係な手順", {
			...cookTimerMusic,
			id: "other",
			title: "無関係な手順",
			summary: "天気だけを調べる",
			useWhen: ["天気を教えて"],
		});
		const third = make("s3", "");
		const stamp = db.query(
			"UPDATE pipeline_work_versions SET created_at=? WHERE work_id=?",
		);
		stamp.run(1_000_000, first);
		stamp.run(2_000_000, second);
		stamp.run(3_000_000, third);
		return { first, second, third };
	});
	const all = await adapter.search({ text: "", limit: 10 }, signal);
	expect(all.map((r) => idOf(r.uri))).toEqual([
		ids.third,
		ids.second,
		ids.first,
	]);
	expect(
		(await adapter.search({ text: "待つ間 タイマー", limit: 10 }, signal)).map(
			(r) => idOf(r.uri),
		),
	).toEqual([ids.first]);
	expect((await adapter.search({ text: "", limit: 1 }, signal)).length).toBe(1);
	expect(
		(
			await adapter.search(
				{
					text: "",
					since: new Date(1_500_000).toISOString(),
					until: new Date(2_500_000).toISOString(),
					limit: 10,
				},
				signal,
			)
		).map((r) => idOf(r.uri)),
	).toEqual([ids.second]);
});

test("read summarizes the definition within 600 tokens and refuses an unknown id", async () => {
	const { store, adapter } = setup();
	const work = await store.write((db) => {
		const a = openWorkInTransaction(db, { sessionId: "s1", target: null });
		commitDocumentInTransaction(db, { kind: "ui" }, a.workRef, {
			baseRevision: 0,
			definition: {
				...cookTimerMusic,
				answer: "答え".repeat(400),
			},
		});
		return a.workRef;
	});
	const text = (await adapter.read(work, signal)).text;
	expect(text).toContain(`パイプライン: ${cookTimerMusic.title}`);
	expect(text).toContain("状態: 未公開の下書き");
	expect(text).toContain("1. 調べる（web.search）");
	expect(estimateTextTokens(text)).toBeLessThanOrEqual(600);
	await expect(adapter.read("missing", signal)).rejects.toThrow(
		"item_not_found",
	);
});
