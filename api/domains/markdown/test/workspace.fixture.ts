import { afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { createQueue, migrations as queueMigrations } from "../../queue";
import {
	createMarkdown,
	migrations,
	type ArchivePort,
	type EditorDocument,
} from "..";
import {
	ArchiveFailure,
	type ArchiveSave,
	type ArchivedDocument,
} from "../contracts";
import { archiveDigest } from "../service/archive-content";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});
export const document = (text: string): EditorDocument => ({
	formatVersion: 1,
	nodes: [
		{
			type: "p",
			align: "center",
			children: [{ text, bold: true, fontSize: "24px", color: "#123456" }],
		},
	],
	originalMarkdown: "\uFEFF# 元の原文\r\n\r\n日本語  \r\n",
});
export const archived = (
	input: ArchiveSave,
	revision = '"' + "a".repeat(64) + '"',
): ArchivedDocument => ({
	entry: {
		sourceId: input.sourceId,
		title: input.title,
		revision,
		namespace: input.namespace,
		path: input.path,
		contentDigest: archiveDigest(input.markdown, input.recovery),
	},
	markdown: input.markdown,
	recovery: input.recovery,
});
export function fixture(save?: ArchivePort["save"]) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-markdown-"));
	const store = openStore(join(dir, "test.sqlite"), [
			...queueMigrations,
			...migrations,
		]),
		queue = createQueue(store);
	let calls = 0,
		binding = "config-1",
		hidden = false;
	const snapshots = new Map<string, ArchivedDocument>();
	const archive: ArchivePort = {
		available: () => true,
		binding: () => binding,
		capabilities: async () => ({
			maxMarkdownBytes: 8 * 1024 * 1024,
			maxRecoveryBytes: 8 * 1024 * 1024,
			maxRequestBytes: 20 * 1024 * 1024,
			maxPageSize: 100,
		}),
		list: async () => ({
			items: [...snapshots.values()].map((v) => v.entry),
			namespaces: ["eumenes"],
			nextCursor: null,
		}),
		read: async (id) => {
			if (hidden || !snapshots.has(id))
				throw new ArchiveFailure(
					"markdown_not_found",
					"failed",
					hidden ? 503 : 404,
				);
			return snapshots.get(id)!;
		},
		save: async (input, signal) => {
			calls++;
			if (input.binding !== binding) throw new Error("configuration_changed");
			if (save) return save(input, signal);
			const remote = archived(
				input,
				'"' + calls.toString(16).padStart(64, "0") + '"',
			);
			snapshots.set(input.sourceId, remote);
			return remote.entry;
		},
	};
	const service = createMarkdown({ store, queue, archive });
	cleanups.push(async () => {
		await queue.close(20);
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const invoke = (operation: string, raw: unknown, id = crypto.randomUUID()) =>
		store.write((db) => service.invokeInTransaction(db, operation, raw, id));
	const view = (id: string) =>
		store.read((db) => service.viewInTransaction(db, id));
	return {
		file: join(dir, "test.sqlite"),
		archive,
		store,
		queue,
		service,
		invoke,
		snapshots,
		view,
		calls: () => calls,
		change: () => {
			binding = "config-2";
		},
		hide: (v: boolean) => {
			hidden = v;
		},
		async create(doc = document("利用者の初稿"), markdown?: string) {
			const { id: stageId } = await service.stage({ document: doc, markdown });
			return invoke("markdown.new.v2", { title: "日本語の文書", stageId });
		},
		async apply(id: string, revision: number, doc: EditorDocument) {
			const { id: stageId } = await service.stage({ document: doc });
			return invoke("markdown.apply.v2", {
				documentId: id,
				expectedRevision: revision,
				title: "日本語の文書",
				stageId,
			});
		},
		async saveDoc(
			id: string,
			revision: number,
			markdown = "# 保存される本文\n",
		) {
			const current = view(id);
			const { id: stageId } = await service.stage({
				document: current.document,
				markdown,
			});
			return invoke("markdown.archive", {
				documentId: id,
				expectedRevision: revision,
				stageId,
			});
		},
	};
}
export async function flush() {
	for (let i = 0; i < 60; i++) await new Promise((r) => setImmediate(r));
}
export { cleanups };
