import { expect, test } from "bun:test";
import { sha256Hex } from "../../../infrastructure/digest";
import { openStore } from "../../../infrastructure/sqlite";
import { createQueue, migrations as queueMigrations } from "../../queue";
import { createMarkdown, migrations, encodeArchive, decodeArchive } from "..";
import { emptyDocument } from "../contracts";
import { waitFor } from "../../../infrastructure/wait-for";

import {
	fixture,
	document,
	archived,
	flush,
	cleanups,
} from "./workspace.fixture";
test("archive v2 preserves frontmatter and rejects changes; legacy v1 remains readable", () => {
	const documentId = crypto.randomUUID(),
		name = "保存形式の確認",
		doc = document("装飾付きの日本語"),
		markdown = "---\ntitle: メタ情報\n---\n\n本文\n",
		raw = encodeArchive(documentId, name, doc, markdown),
		expected = { documentId, title: name, document: doc, markdown };
	expect(raw.startsWith("\n---\n")).toBe(true);
	expect(decodeArchive(raw)).toEqual(expected);
	expect(() => decodeArchive(raw.replace("本文", "変更"))).toThrow(
		"markdown_source_invalid",
	);
	expect(() =>
		decodeArchive(raw.replace(documentId, crypto.randomUUID())),
	).toThrow("markdown_source_invalid");
	const payload = Buffer.from(
		JSON.stringify({
			documentId,
			title: name,
			document: doc,
			markdownDigest: sha256Hex(markdown),
		}),
	).toString("base64");
	expect(
		decodeArchive(
			`<!-- eumenes-plate-document:v1\n${payload}\n-->\n${markdown}`,
		),
	).toEqual(expected);
});
test("Plate decorations and exact imported original survive native recovery and reopen", async () => {
	const h = fixture(),
		created = await h.create();
	await h.saveDoc(created.documentId, 1);
	await h.queue.tick();
	await flush();
	expect(h.view(created.documentId)).toMatchObject({
		saveState: "saved",
		dirty: false,
		sourceId: expect.stringMatching(/^wiki-[a-f0-9]{32}$/),
	});
	const saved = h.snapshots.get(h.view(created.documentId).sourceId!)!;
	expect(JSON.parse(saved.recovery)).toEqual(document("利用者の初稿"));
	expect(saved.markdown).toBe("# 保存される本文\n");
	await h.service.open(
		h.view(created.documentId).sourceId!,
		new AbortController().signal,
	);
	expect(h.view(created.documentId).document).toEqual(document("利用者の初稿"));
	expect(h.view(created.documentId)).toMatchObject({
		revision: 2,
		dirty: false,
	});
	await h.apply(created.documentId, 2, document("継続編集"));
	await h.saveDoc(created.documentId, 3);
	await h.queue.tick();
	await flush();
	expect(h.calls()).toBe(2);
	expect(h.snapshots.size).toBe(1);
	expect(h.snapshots.get(h.view(created.documentId).sourceId!)!.recovery).toBe(
		JSON.stringify(document("継続編集")),
	);
});
test("stale user or collaborator edit cannot overwrite the current document", async () => {
	const h = fixture(),
		created = await h.create();
	const work = await h.store.write((db) =>
		h.service.session.openInTransaction(db, {
			sessionId: crypto.randomUUID(),
			targetRef: created.documentId,
		}),
	);
	await h.store.write((db) =>
		h.service.session.beginTurnInTransaction(db, work.workRef, "run-1"),
	);
	await h.apply(created.documentId, 1, document("利用者が先に編集"));
	await expect(
		h.store.write((db) =>
			h.service.session.document.commitInTransaction(db, work.workRef, {
				baseRevision: 1,
				value: document("AIによる変更"),
				origin: { kind: "specialist", workRef: work.workRef, runId: "run-1" },
			}),
		),
	).rejects.toThrow("revision_conflict");
	expect(h.view(created.documentId).document).toEqual(
		document("利用者が先に編集"),
	);
	await expect(
		h.apply(created.documentId, 1, document("古い利用者の変更")),
	).rejects.toThrow("revision_conflict");
	await h.store.write((db) =>
		h.service.session.document.commitInTransaction(db, work.workRef, {
			baseRevision: 2,
			value: document("最新を踏まえたAIの編集"),
			origin: { kind: "specialist", workRef: work.workRef, runId: "run-1" },
		}),
	);
	expect(h.view(created.documentId)).toMatchObject({ revision: 3 });
});
test("save freezes its snapshot and leaves newer typing dirty after completion", async () => {
	const gate = Promise.withResolvers<void>();
	const h = fixture(async (input) => {
		await gate.promise;
		return archived(input).entry;
	});
	const created = await h.create();
	await h.saveDoc(created.documentId, 1);
	await h.queue.tick();
	await flush();
	expect(h.view(created.documentId).saveState).toBe("saving");
	await h.apply(created.documentId, 1, document("保存待ちの間の追記"));
	gate.resolve();
	await flush();
	expect(h.view(created.documentId)).toMatchObject({
		revision: 2,
		archivedRevision: 1,
		dirty: true,
		saveState: "saved",
	});
	expect(h.view(created.documentId).document).toEqual(
		document("保存待ちの間の追記"),
	);
});
test.each(["failure", "configuration", "cancel", "interrupt"])(
	"unconfirmed %s never becomes saved or retries",
	async (mode) => {
		const gate = Promise.withResolvers<void>();
		const h = fixture(async (_input) => {
			if (mode === "cancel" || mode === "interrupt") await gate.promise;
			throw new Error("unavailable");
		});
		const created = await h.create();
		await h.saveDoc(created.documentId, 1);
		if (mode === "configuration") h.change();
		await h.queue.tick();
		await flush();
		if (mode === "cancel") await h.queue.cancel(h.queue.list().items[0]!.id);
		if (mode === "interrupt") await h.queue.close(1);
		gate.resolve();
		await waitFor(() => h.view(created.documentId).saveState !== "saving", {
			timeout: 3000,
		});
		expect(h.view(created.documentId)).toMatchObject({
			dirty: true,
			saveState: "unknown",
		});
		expect(h.queue.list().items[0]!.state).not.toBe("completed");
		expect(h.calls()).toBe(1);
		await h.queue.tick();
		await flush();
		expect(h.calls()).toBe(1);
	},
);
test("staged input keeps the ledger small, is single-use and rejects malformed editor trees", async () => {
	const invalid = fixture();
	await expect(
		invalid.service.stage({
			document: { ...emptyDocument(), nodes: [{ text: "root leaf" }] },
		}),
	).rejects.toThrow();
	await expect(
		invalid.service.stage({
			document: {
				...emptyDocument(),
				nodes: [{ type: "p", text: "root leaf with element type" }],
			},
		}),
	).rejects.toThrow();
	const h = fixture(),
		doc = document("あ".repeat(50000)),
		staged = await h.service.stage({ document: doc });
	const request = { title: "長い文書", stageId: staged.id },
		requestId = crypto.randomUUID();
	expect(JSON.stringify(request).length).toBeLessThan(100);
	const first = await h.invoke("markdown.new", request, requestId);
	expect(h.view(first.documentId).document).toEqual(doc);
	expect(await h.invoke("markdown.new", request, requestId)).toEqual(first);
	await expect(h.invoke("markdown.new", request)).rejects.toThrow(
		"markdown_input_expired",
	);
	await expect(
		h.service.stage({
			document: {
				...emptyDocument(),
				nodes: [{ type: "script", children: [{ text: "bad" }] }],
			},
		}),
	).rejects.toThrow();
	await expect(
		h.service.stage({
			document: {
				...emptyDocument(),
				nodes: [
					{
						type: "a",
						url: "javascript:alert(1)",
						children: [{ text: "bad" }],
					},
				],
			},
		}),
	).rejects.toThrow();
	expect(() =>
		decodeArchive("<!-- eumenes-plate-document:v1\nbnVsbA==\n-->\n"),
	).toThrow();
	const raw = encodeArchive(first.documentId, "長い文書", doc, "本文");
	expect(() => decodeArchive(raw + "改変")).toThrow("markdown_source_invalid");
});

test("startup recovery settles a persisted running save with no prepared in-memory input", async () => {
	const h = fixture(),
		created = await h.create();
	await h.saveDoc(created.documentId, 1);
	const job = h.queue.list().items[0]!;
	await h.store.write((db) =>
		db
			.query(
				"UPDATE queue_jobs SET state='running',owner='lost-process',attempt=1,lease_until_ms=1 WHERE id=?",
			)
			.run(job.id),
	);
	expect(await h.queue.recover()).toBe(1);
	expect(h.view(created.documentId)).toMatchObject({
		saveState: "unknown",
		dirty: true,
	});
	expect(h.calls()).toBe(0);
	expect(
		h.store.read((db) =>
			db.query("SELECT count(*) AS n FROM markdown_saves").get(),
		),
	).toEqual({ n: 1 });
});

test("explicit GET reconciliation confirms the frozen snapshot and preserves later edits", async () => {
	const h = fixture(async (input) => {
		h.snapshots.set(input.sourceId, archived(input));
		throw new Error("lost-response");
	});
	h.hide(true);
	const created = await h.create();
	await h.saveDoc(created.documentId, 1);
	await h.queue.tick();
	await flush();
	expect(h.view(created.documentId).saveState).toBe("unknown");
	await h.apply(created.documentId, 1, document("切断後の追記"));
	h.hide(false);
	await h.service.reconcile(created.documentId, new AbortController().signal);
	expect(h.view(created.documentId)).toMatchObject({
		saveState: "saved",
		archivedRevision: 1,
		revision: 2,
		dirty: true,
	});
	expect(h.view(created.documentId).document).toEqual(document("切断後の追記"));
	expect(h.calls()).toBe(1);
});
test("repeated 404s remain unknown without another PUT; different content becomes conflict", async () => {
	const h = fixture(async () => {
		throw new Error("not-delivered");
	});
	const created = await h.create();
	await h.saveDoc(created.documentId, 1);
	await h.queue.tick();
	await new Promise((r) => setTimeout(r, 700));
	await flush();
	await h.service.reconcile(created.documentId, new AbortController().signal);
	expect(h.view(created.documentId).saveState).toBe("unknown");
	await expect(h.saveDoc(created.documentId, 1)).rejects.toThrow(
		"markdown_archive_unknown",
	);
	const id = h.view(created.documentId).sourceId!;
	const pending = h.store.read((db) =>
		db.query("SELECT * FROM markdown_saves").get(),
	) as import("../repository").PendingSave;
	const remote = archived({
		documentId: created.documentId,
		sourceId: id,
		title: pending.title,
		markdown: "外で変更",
		recovery: JSON.stringify(document("外で変更")),
		remoteRevision: null,
		binding: pending.binding,
		namespace: pending.namespace!,
		path: pending.path!,
		contentDigest: "",
	});
	h.snapshots.set(id, remote);
	await h.service.reconcile(created.documentId, new AbortController().signal);
	expect(h.view(created.documentId)).toMatchObject({
		saveState: "conflict",
		saveError: "markdown_archive_conflict",
	});
	expect(h.view(created.documentId).document).toEqual(document("利用者の初稿"));
	expect(h.calls()).toBe(1);
});

test("database reopen retains pending work and last Desk baseline without a version history", async () => {
	const h = fixture(),
		created = await h.create();
	await h.saveDoc(created.documentId, 1);
	await h.queue.tick();
	await flush();
	await h.apply(created.documentId, 1, document("閉じる前の未保存の追記"));
	const sourceId = h.view(created.documentId).sourceId!;
	await h.queue.close(20);
	await h.store.close();
	const store = openStore(h.file, [...queueMigrations, ...migrations]),
		queue = createQueue(store),
		service = createMarkdown({ store, queue, archive: h.archive });
	cleanups.unshift(async () => {
		await queue.close(20);
		await store.close();
	});
	const view = () =>
		store.read((db) => service.viewInTransaction(db, created.documentId));
	expect(view()).toMatchObject({
		revision: 2,
		archivedRevision: 1,
		dirty: true,
	});
	expect(view().document).toEqual(document("閉じる前の未保存の追記"));
	await expect(
		service.open(sourceId, new AbortController().signal),
	).rejects.toThrow("revision_conflict");
	const work = await store.write((db) =>
		service.session.openInTransaction(db, {
			sessionId: crypto.randomUUID(),
			targetRef: created.documentId,
		}),
	);
	await store.write((db) =>
		service.session.endInTransaction(db, work.workRef, "discard"),
	);
	await service.open(sourceId, new AbortController().signal);
	expect(view().document).toEqual(document("利用者の初稿"));
	expect(view().dirty).toBe(false);
});

test("native UTF8 limits reject oversized staging without submitting a save", async () => {
	const h = fixture(),
		created = await h.create();
	await expect(
		h.service.stage({
			document: h.view(created.documentId).document,
			markdown: "あ".repeat(Math.ceil((8 * 1024 * 1024) / 3)),
		}),
	).rejects.toThrow();
	await expect(
		h.service.stage({ document: document("x".repeat(8 * 1024 * 1024)) }),
	).rejects.toThrow();
	expect(h.calls()).toBe(0);
	expect(h.queue.list().items).toHaveLength(0);
	expect(h.view(created.documentId).saveState).toBe("unsaved");
});
