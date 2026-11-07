import { expect, test } from "bun:test";
import { fixture, document, archived, flush } from "./workspace.fixture";
import { ArchiveFailure, type ArchiveSave } from "../contracts";
import { archiveDigest } from "../service/archive-content";

const signal = () => AbortSignal.timeout(5000);
const id = `wiki-${"e".repeat(32)}`;
const etag = '"' + "b".repeat(64) + '"';
const imported = () => {
	const markdown = "\uFEFF# 日本語\r\n\r\n末尾の空白  \r\n";
	const doc = document("装飾付きの日本語");
	doc.originalMarkdown = markdown;
	const recovery = JSON.stringify(doc, null, "  ") + "\n";
	return {
		doc,
		markdown,
		recovery,
		remote: {
			entry: {
				sourceId: id,
				title: " 元の題名 ",
				revision: etag,
				namespace: "eumenes",
				path: "notes/日本語.md",
				contentDigest: archiveDigest(markdown, recovery),
			},
			markdown,
			recovery,
		},
	};
};
test("reopening maps a stable remote ID and preserves opaque recovery and exact Markdown on title-only update", async () => {
	const h = fixture(),
		source = imported();
	h.snapshots.set(id, source.remote);
	const opened = await h.service.open(id, signal());
	expect(opened.document).toEqual(source.doc);
	expect(opened.remote?.etag).toBe(etag);
	const { id: stageId } = await h.service.stage({ document: opened.document });
	const title = " 日本語".repeat(250) + " ";
	await h.invoke("markdown.apply.v2", {
		documentId: opened.id,
		expectedRevision: opened.revision,
		title,
		stageId,
	});
	await h.saveDoc(
		opened.id,
		2,
		"a serializer must not replace the untouched Markdown",
	);
	await h.queue.tick();
	await flush();
	expect(h.view(opened.id)).toMatchObject({
		title,
		saveState: "saved",
		dirty: false,
	});
	expect(h.snapshots.get(id)).toMatchObject({
		markdown: source.markdown,
		recovery: source.recovery,
	});
	expect((await h.service.open(id, signal())).id).toBe(opened.id);
	expect(h.snapshots.size).toBe(1);
});
test("only an empty recovery accepts a completed Plate import at the same ETag", async () => {
	const h = fixture(),
		source = imported();
	h.snapshots.set(id, {
		...source.remote,
		recovery: "",
		entry: {
			...source.remote.entry,
			contentDigest: archiveDigest(source.markdown, ""),
		},
	});
	expect((await h.service.preview(id, signal())).document).toBeNull();
	await expect(h.service.open(id, signal())).rejects.toThrow(
		"markdown_import_required",
	);
	const { id: stageId } = await h.service.stage({
		document: source.doc,
		markdown: source.markdown,
	});
	await expect(
		h.service.open(id, signal(), {
			stageId,
			expectedEtag: '"' + "c".repeat(64) + '"',
		}),
	).rejects.toThrow("revision_conflict");
	const opened = await h.service.open(id, signal(), {
		stageId,
		expectedEtag: etag,
	});
	expect(opened.document).toEqual(source.doc);
	await h.saveDoc(opened.id, opened.revision);
	await h.queue.tick();
	await flush();
	expect(h.snapshots.get(id)?.markdown).toBe(source.markdown);
	expect(JSON.parse(h.snapshots.get(id)!.recovery)).toEqual(source.doc);
	h.snapshots.set(id, { ...source.remote, recovery: "not a valid recovery" });
	await expect(h.service.preview(id, signal())).rejects.toThrow(
		"markdown_source_invalid",
	);
	await expect(h.service.open(id, signal())).rejects.toThrow(
		"markdown_source_invalid",
	);
	expect(h.view(opened.id).document).toEqual(source.doc);
});
test("ID and frozen input persist before dispatch, definite rejection reuses the ID and writes stay serialized", async () => {
	const gate = Promise.withResolvers<void>(),
		requests: ArchiveSave[] = [];
	const h = fixture(async (input) => {
		requests.push(structuredClone(input));
		expect(h.view(input.documentId).sourceId).toBe(input.sourceId);
		if (requests.length === 1)
			throw new ArchiveFailure("markdown_path_exists", "failed", 409);
		await gate.promise;
		return archived(input).entry;
	});
	const made = await h.create();
	await h.saveDoc(made.documentId, 1);
	await h.queue.tick();
	await flush();
	expect(h.view(made.documentId).saveState).toBe("unsaved");
	await h.saveDoc(made.documentId, 1);
	await h.queue.tick();
	await flush();
	await expect(h.saveDoc(made.documentId, 1)).rejects.toThrow(
		"markdown_save_in_progress",
	);
	expect(requests[0]?.sourceId).toBe(requests[1]?.sourceId);
	expect(requests[0]?.remoteRevision).toBeNull();
	expect(requests[1]?.remoteRevision).toBeNull();
	gate.resolve();
	await flush();
	expect(h.view(made.documentId).saveState).toBe("saved");
});
test("412 preserves local content, GETs latest and requires explicit resolution before using its ETag", async () => {
	const requests: ArchiveSave[] = [];
	const h = fixture(async (input) => {
		requests.push(structuredClone(input));
		const current = h.snapshots.get(input.sourceId);
		if (current && input.remoteRevision !== current.entry.revision)
			throw new ArchiveFailure("markdown_archive_conflict", "conflict", 412);
		const remote = archived(
			input,
			'"' + requests.length.toString(16).padStart(64, "0") + '"',
		);
		h.snapshots.set(input.sourceId, remote);
		return remote.entry;
	});
	const made = await h.create();
	await h.saveDoc(made.documentId, 1);
	await h.queue.tick();
	await flush();
	const remoteId = h.view(made.documentId).sourceId!,
		old = h.snapshots.get(remoteId)!;
	h.snapshots.set(remoteId, {
		...old,
		markdown: "外の編集",
		entry: {
			...old.entry,
			revision: etag,
			contentDigest: archiveDigest("外の編集", old.recovery),
		},
	});
	await h.apply(made.documentId, 1, document("手元の編集"));
	await h.saveDoc(made.documentId, 2);
	await h.queue.tick();
	await flush();
	expect(h.view(made.documentId)).toMatchObject({
		saveState: "conflict",
		remote: { etag: old.entry.revision },
		conflict: { entry: { revision: etag }, markdown: "外の編集" },
	});
	expect(h.view(made.documentId).document).toEqual(document("手元の編集"));
	await expect(h.saveDoc(made.documentId, 2)).rejects.toThrow(
		"markdown_archive_conflict",
	);
	expect(requests).toHaveLength(2);
	await expect(h.service.resolve(made.documentId, 1, etag)).rejects.toThrow(
		"revision_conflict",
	);
	const resolved = await h.service.resolve(made.documentId, 2, etag);
	expect(resolved).toMatchObject({
		revision: 3,
		saveState: "unsaved",
		dirty: true,
	});
	expect(requests).toHaveLength(2);
	await h.saveDoc(made.documentId, 3);
	await h.queue.tick();
	await flush();
	expect(requests[2]?.remoteRevision).toBe(etag);
	expect(requests.every((r) => r.sourceId === remoteId)).toBe(true);
	expect(h.view(made.documentId)).toMatchObject({
		saveState: "saved",
		dirty: false,
	});
});
test("a lost PUT response is confirmed by exact digest, title, namespace and path without a resend", async () => {
	const h = fixture(async (input) => {
		h.snapshots.set(input.sourceId, archived(input));
		throw new ArchiveFailure("markdown_archive_unknown", "unknown", 503);
	});
	const made = await h.create();
	await h.saveDoc(made.documentId, 1);
	await h.queue.tick();
	await flush();
	expect(h.view(made.documentId).saveState).toBe("saved");
	expect(h.calls()).toBe(1);
});

test("412 remains a conflict even when latest content matches the attempted save", async () => {
	const h = fixture(async (input) => {
		h.snapshots.set(input.sourceId, archived(input));
		throw new ArchiveFailure("markdown_archive_conflict", "conflict", 412);
	});
	const made = await h.create();
	await h.saveDoc(made.documentId, 1);
	await h.queue.tick();
	await flush();
	expect(h.view(made.documentId)).toMatchObject({
		saveState: "conflict",
		remote: { etag: null },
	});
	await h.service.reconcile(made.documentId, signal());
	expect(h.view(made.documentId)).toMatchObject({
		saveState: "conflict",
		remote: { etag: null },
	});
	expect(h.calls()).toBe(1);
});
