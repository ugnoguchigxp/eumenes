import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { estimateTextTokens } from "../../../infrastructure/context-budget";
import { openStore } from "../../../infrastructure/sqlite";
import { migrations as queueMigrations } from "../../queue";
import { formatResourceUri, parseResourceUri } from "../../resources";
import { createOcrResourceAdapter, migrations } from "..";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const c of cleanup.splice(0)) await c();
});
function setup() {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-ocr-resource-"));
	const store = openStore(join(dir, "db"), [...queueMigrations, ...migrations]);
	cleanup.push(async () => {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	return { store, adapter: createOcrResourceAdapter({ store }) };
}
const line = (text: string) => ({
	text,
	confidence: 0.9,
	polygon: [
		[1, 2],
		[31, 2],
		[31, 18],
		[1, 18],
	],
});
function input(
	db: Database,
	id: string,
	options: {
		name: string;
		text: string;
		createdAt: number;
		state?: string;
		video?: boolean;
	},
) {
	const state = options.state ?? "completed";
	const result =
		state !== "completed"
			? null
			: options.video
				? {
						kind: "video",
						model: "ocr-fixture",
						video: { width: 100, height: 100 },
						frames: [
							{
								timestampSeconds: 0,
								text: options.text,
								lines: [line(options.text)],
							},
						],
					}
				: {
						kind: "image",
						model: "ocr-fixture",
						width: 100,
						height: 100,
						text: options.text,
						lines: [line(options.text)],
					};
	db.query(
		"INSERT INTO ocr_inputs(id,owner,conversation_id,mime,bytes,record_json,connection_json,deadline) VALUES(?,?,?,?,?,?,?,?)",
	).run(
		id,
		"local:owner",
		"main",
		options.video ? "video/mp4" : "image/png",
		new Uint8Array([1]),
		JSON.stringify({
			id,
			conversationId: "main",
			name: options.name,
			mime: options.video ? "video/mp4" : "image/png",
			state,
			revision: 1,
			progress: null,
			errorCode: null,
			result,
			createdAt: options.createdAt,
			updatedAt: options.createdAt,
		}),
		"{}",
		options.createdAt + 600_000,
	);
}
function correction(
	db: Database,
	id: string,
	sourceId: string,
	text: string,
	createdAt: number,
) {
	db.query(
		"INSERT INTO ocr_corrections(id,source_id,owner,conversation_id,frame_key,source_revision,source_digest,record_json,bindings_json) VALUES(?,?,?,?,?,?,?,?,?)",
	).run(
		id,
		sourceId,
		"local:owner",
		"main",
		-1,
		1,
		"a".repeat(64),
		JSON.stringify({
			id,
			sourceId,
			frameIndex: null,
			sourceRevision: 1,
			sourceDigest: "a".repeat(64),
			state: "completed",
			errorCode: null,
			result: {
				blocks: [
					{
						kind: "paragraph",
						text,
						evidence: { lineIndexes: [0] },
						uncertain: true,
						uncertainty: "判読が難しい",
					},
				],
				excludedLines: [],
			},
			createdAt,
			updatedAt: createdAt,
		}),
		"{}",
	);
}

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const D = "44444444-4444-4444-8444-444444444444";
const base = Date.UTC(2026, 9, 20);

test("a result's OCR record becomes a document ref; unfinished and unknown ones do not", async () => {
	const { store, adapter } = setup();
	await store.write((db) => {
		input(db, A, { name: "領収書.png", text: "合計 1,200円", createdAt: base });
		input(db, B, {
			name: "待ち.png",
			text: "",
			createdAt: base + 1,
			state: "running",
		});
	});
	const refs = store.read((db) => [
		adapter.fromResultInTransaction(
			db,
			{ id: A, state: "completed" },
			{ conversationId: "main" },
		),
		adapter.fromResultInTransaction(
			db,
			{
				receipt: { id: A },
				resultRefs: [{ owner: "ocr", kind: "x", id: A }],
			},
			{ conversationId: "main" },
		),
		adapter.fromResultInTransaction(db, { id: B }, { conversationId: "main" }),
		adapter.fromResultInTransaction(db, { id: C }, { conversationId: "main" }),
		adapter.fromResultInTransaction(
			db,
			{
				resultRefs: [{ owner: "image", kind: "x", id: A }],
			},
			{ conversationId: "main" },
		),
		adapter.fromResultInTransaction(db, "text", { conversationId: "main" }),
		adapter.fromResultInTransaction(
			db,
			{
				action: "open",
				state: "ready_for_input",
			},
			{ conversationId: "main" },
		),
	]);
	expect(refs[0]).toEqual([
		{
			uri: formatResourceUri("document", A),
			kind: "document",
			label: "領収書.png",
			createdAt: new Date(base).toISOString(),
		},
	]);
	expect(refs[1]).toEqual(refs[0]!);
	expect(refs.slice(2).every((r) => r.length === 0)).toBe(true);
});

test("get: view for the OCR screen, a correction points at its source, a missing id is null", async () => {
	const { store, adapter } = setup();
	await store.write((db) => {
		input(db, A, { name: "領収書.png", text: "合計 1,200円", createdAt: base });
		correction(db, D, A, "合計 1,200円（税込）", base + 5);
	});
	const [doc, fixed, missing, foreign] = store.read((db) => [
		adapter.getInTransaction(db, A),
		adapter.getInTransaction(db, D),
		adapter.getInTransaction(db, B),
		adapter.getInTransaction(db, "kanban:x"),
	]);
	expect(doc).toMatchObject({
		adapterRef: "adapter:ocr@1",
		targetRef: A,
		actions: ["open", "read"],
		label: "領収書.png",
		preview: "合計 1,200円",
	});
	expect(fixed).toMatchObject({
		adapterRef: "adapter:ocr@1",
		targetRef: A,
		label: "領収書.png（校正）",
	});
	expect(parseResourceUri(fixed!.uri)?.id).toBe(D);
	expect(missing).toBeNull();
	expect(foreign).toBeNull();
});

test("search matches name and text, newest first, bounded by limit and period; unfinished are skipped", async () => {
	const { store, adapter } = setup();
	await store.write((db) => {
		input(db, A, { name: "領収書.png", text: "合計 1,200円", createdAt: base });
		input(db, B, {
			name: "メモ.mp4",
			text: "合計は来週",
			createdAt: base + 10,
			video: true,
		});
		input(db, C, {
			name: "途中.png",
			text: "",
			createdAt: base + 20,
			state: "running",
		});
		correction(db, D, A, "合計 1,200円（税込）", base + 30);
	});
	const signal = new AbortController().signal;
	const all = await adapter.search({ text: "合計", limit: 10 }, signal);
	expect(all.map((r) => parseResourceUri(r.uri)?.id)).toEqual([D, B, A]);
	expect(
		(await adapter.search({ text: "合計", limit: 2 }, signal)).length,
	).toBe(2);
	expect(
		(await adapter.search({ text: "領収書 税込", limit: 10 }, signal)).map(
			(r) => parseResourceUri(r.uri)?.id,
		),
	).toEqual([D]);
	expect(
		(
			await adapter.search(
				{
					text: "",
					since: new Date(base + 5).toISOString(),
					until: new Date(base + 15).toISOString(),
					limit: 10,
				},
				signal,
			)
		).map((r) => parseResourceUri(r.uri)?.id),
	).toEqual([B]);
	expect(
		await adapter.search({ text: "存在しない語", limit: 10 }, signal),
	).toEqual([]);
});

test("read stays within 600 tokens, missing ids are refused", async () => {
	const { store, adapter } = setup();
	const long = "とても長い原文です。".repeat(400);
	await store.write((db) => {
		input(db, A, { name: "長い.png", text: long, createdAt: base });
		input(db, B, {
			name: "短い.png",
			text: "短い",
			createdAt: base + 1,
			state: "failed",
		});
	});
	const signal = new AbortController().signal;
	const text = (await adapter.read(A, signal)).text;
	expect(text).toContain("文書: 長い.png");
	expect(estimateTextTokens(text)).toBeLessThanOrEqual(600);
	expect((await adapter.read(B, signal)).text).toContain(
		"読み取りに失敗しました",
	);
	await expect(adapter.read(C, signal)).rejects.toThrow("item_not_found");
	await expect(adapter.read("codex:x", signal)).rejects.toThrow(
		"item_not_found",
	);
});
