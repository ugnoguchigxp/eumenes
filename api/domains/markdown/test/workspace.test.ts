import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { createQueue, migrations as queueMigrations } from "../../queue";
import {
	createMarkdown,
	migrations,
	encodeArchive,
	decodeArchive,
	type ArchivePort,
	type EditorDocument,
} from "..";
import { emptyDocument } from "../contracts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});
const document = (text: string): EditorDocument => ({
	formatVersion: 1,
	nodes: [
		{
			type: "p",
			align: "center",
			children: [{ text, bold: true, fontSize: "24px", color: "#123456" }],
		},
	],
	originalMarkdown: "# 元の原文\r\n\r\n日本語  \r\n",
});
async function flush() {
	for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
}
function fixture(save?: ArchivePort["save"]) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-markdown-"));
	const store = openStore(join(dir, "test.sqlite"), [
		...queueMigrations,
		...migrations,
	]);
	const queue = createQueue(store);
	let calls = 0,
		binding = "config-1";
	const snapshots = new Map<
		string,
		{
			entry: {
				sourceId: string;
				documentId: string;
				title: string;
				revision: string;
				path: string;
			};
			document: EditorDocument;
		}
	>();
	const archive: ArchivePort = {
		available: () => true,
		binding: () => binding,
		list: async () => [...snapshots.values()].map((v) => v.entry),
		read: async (id) => snapshots.get(id)!,
		save: async (input, signal) => {
			calls++;
			if (input.binding !== binding) throw new Error("configuration_changed");
			if (save) return save(input, signal);
			const entry = {
				sourceId: input.sourceId ?? "desk-id",
				documentId: input.documentId,
				title: input.title,
				revision: `r${calls}`,
				path: `${input.documentId}.md`,
			};
			snapshots.set(entry.sourceId, { entry, document: input.document });
			return entry;
		},
	};
	const service = createMarkdown({ store, queue, archive });
	cleanups.push(async () => {
		await queue.close(20);
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	async function invoke(
		operation: string,
		raw: unknown,
		id = crypto.randomUUID(),
	) {
		return store.write((db) =>
			service.invokeInTransaction(db, operation, raw, id),
		);
	}
	async function create(doc = document("利用者の初稿")) {
		const { id: stageId } = await service.stage({ document: doc });
		return invoke("markdown.new", { title: "日本語の文書", stageId });
	}
	async function apply(id: string, revision: number, doc: EditorDocument) {
		const { id: stageId } = await service.stage({ document: doc });
		return invoke("markdown.apply", {
			documentId: id,
			expectedRevision: revision,
			title: "日本語の文書",
			stageId,
		});
	}
	async function saveDoc(id: string, revision: number) {
		const current = store.read((db) => service.viewInTransaction(db, id));
		const { id: stageId } = await service.stage({
			document: current.document,
			markdown: "# 保存される本文\n",
		});
		return invoke("markdown.archive", {
			documentId: id,
			expectedRevision: revision,
			stageId,
		});
	}
	return {
		file: join(dir, "test.sqlite"),
		archive,
		store,
		queue,
		service,
		invoke,
		create,
		apply,
		saveDoc,
		snapshots,
		calls: () => calls,
		change: () => {
			binding = "config-2";
		},
		view: (id: string) => store.read((db) => service.viewInTransaction(db, id)),
	};
}
test("Plate decorations and exact imported original survive Desk envelope and reopen", async () => {
	const h = fixture(),
		created = await h.create();
	await h.saveDoc(created.documentId, 1);
	await h.queue.tick();
	await flush();
	expect(h.view(created.documentId)).toMatchObject({
		saveState: "saved",
		dirty: false,
		sourceId: "desk-id",
	});
	const saved = h.snapshots.get("desk-id")!,
		raw = encodeArchive(
			saved.entry.documentId,
			saved.entry.title,
			saved.document,
			"# 保存される本文\n",
		);
	expect(decodeArchive(raw).document).toEqual(document("利用者の初稿"));
	await h.service.open("desk-id", new AbortController().signal);
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
	expect(h.snapshots.get("desk-id")!.document).toEqual(document("継続編集"));
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
		return {
			sourceId: "desk-id",
			documentId: input.documentId,
			title: input.title,
			revision: "saved-1",
			path: `${input.documentId}.md`,
		};
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
		await flush();
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

test("explicit GET reconciliation restores a confirmed Desk save and preserves later edits", async () => {
	const h = fixture(async (input) => {
		h.snapshots.set("desk-id", {
			entry: {
				sourceId: "desk-id",
				documentId: input.documentId,
				title: input.title,
				revision: "accepted-before-disconnect",
				path: `${input.documentId}.md`,
			},
			document: input.document,
		});
		throw new Error("lost-response");
	});
	const created = await h.create();
	await h.saveDoc(created.documentId, 1);
	await h.queue.tick();
	await flush();
	expect(h.view(created.documentId).saveState).toBe("unknown");
	await h.apply(created.documentId, 1, document("切断後の追記"));
	await h.service.reconcile(created.documentId, new AbortController().signal);
	expect(h.view(created.documentId)).toMatchObject({
		sourceId: "desk-id",
		saveState: "saved",
		archivedRevision: 1,
		revision: 2,
		dirty: true,
	});
	expect(h.view(created.documentId).document).toEqual(document("切断後の追記"));
	expect(h.calls()).toBe(1);
});
test("confirmed absence permits an explicit new save, while different Desk content remains a conflict", async () => {
	const h = fixture(async () => {
			throw new Error("not-delivered");
		}),
		created = await h.create();
	await h.saveDoc(created.documentId, 1);
	await h.queue.tick();
	await flush();
	await h.service.reconcile(created.documentId, new AbortController().signal);
	expect(h.view(created.documentId).saveState).toBe("unsaved");
	expect(h.calls()).toBe(1);
	await h.saveDoc(created.documentId, 1);
	await h.queue.tick();
	await flush();
	expect(h.calls()).toBe(2);
	h.snapshots.set("other", {
		entry: {
			sourceId: "other",
			documentId: created.documentId,
			title: "日本語の文書",
			revision: "outside",
			path: `${created.documentId}.md`,
		},
		document: document("外で変更"),
	});
	await h.service.reconcile(created.documentId, new AbortController().signal);
	expect(h.view(created.documentId)).toMatchObject({
		saveState: "unknown",
		saveError: "markdown_archive_conflict",
	});
	expect(h.view(created.documentId).document).toEqual(document("利用者の初稿"));
	expect(h.calls()).toBe(2);
});

test("database reopen retains pending work and last Desk baseline without a version history", async () => {
	const h = fixture(),
		created = await h.create();
	await h.saveDoc(created.documentId, 1);
	await h.queue.tick();
	await flush();
	await h.apply(created.documentId, 1, document("閉じる前の未保存の追記"));
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
		service.open("desk-id", new AbortController().signal),
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
	await service.open("desk-id", new AbortController().signal);
	expect(view().document).toEqual(document("利用者の初稿"));
	expect(view().dirty).toBe(false);
});
