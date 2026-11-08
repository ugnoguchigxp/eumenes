import { expect, test } from "bun:test";
import { Hono } from "hono";
import { registerMarkdown } from "..";
import { document } from "./workspace.fixture";
import {
	managementFixture,
	docId,
	folderId,
	otherId,
	tag,
} from "./library-management.fixture";
const signal = () => AbortSignal.timeout(10000);
test("document metadata changes adopt the same workspace without changing opaque content; copy keeps its source", async () => {
	const h = managementFixture(),
		opened = await h.service.open(docId, signal()),
		other = structuredClone(h.entries.get(otherId));
	const patch = {
			op: "patch" as const,
			kind: "document" as const,
			id: docId,
			namespace: "eumenes",
			etag: tag("a"),
			path: "整理/新名.md",
			title: "新題",
		},
		id = crypto.randomUUID();
	expect((await h.service.manage(id, patch, signal())).state).toBe("applied");
	const after = h.view(opened.id);
	expect(after.remote?.path).toBe("整理/新名.md");
	expect(after.title).toBe("新題");
	expect(after.document).toEqual(opened.document);
	expect(after.markdown).toBe(h.raw);
	expect((await h.service.manage(id, patch, signal())).state).toBe("applied");
	expect(h.calls()).toBe(1);
	const copyId = `wiki-${"3".repeat(32)}`;
	expect(
		(
			await h.service.manage(
				crypto.randomUUID(),
				{
					op: "copy",
					kind: "document",
					id: docId,
					namespace: "eumenes",
					etag: tag("e"),
					path: "複製.md",
					newId: copyId,
				},
				signal(),
			)
		).state,
	).toBe("applied");
	expect(h.view(opened.id).sourceId).toBe(docId);
	expect(h.entries.get(copyId)).toMatchObject({
		path: "複製.md",
		contentDigest: h.snapshots.get(docId)!.entry.contentDigest,
	});
	expect(h.entries.get(otherId)).toEqual(other);
});
test("empty folder creation, recursive move/copy and batch deletion preserve exact request conditions", async () => {
	const h = managementFixture(),
		empty = `folder-${"f".repeat(32)}`,
		newRoot = `folder-${"b".repeat(32)}`;
	expect(
		(
			await h.service.manage(
				crypto.randomUUID(),
				{ op: "create-folder", id: empty, namespace: "eumenes", path: "空" },
				signal(),
			)
		).state,
	).toBe("applied");
	expect(
		(
			await h.service.manage(
				crypto.randomUUID(),
				{
					op: "patch",
					kind: "folder",
					id: folderId,
					namespace: "eumenes",
					etag: tag("b"),
					path: "移動",
				},
				signal(),
			)
		).state,
	).toBe("applied");
	expect(h.entries.get(docId)?.path).toBe("移動/文書.md");
	expect(
		(
			await h.service.manage(
				crypto.randomUUID(),
				{
					op: "copy",
					kind: "folder",
					id: folderId,
					namespace: "eumenes",
					etag: tag("e"),
					newId: newRoot,
					path: "複写",
				},
				signal(),
			)
		).state,
	).toBe("applied");
	expect(
		[...h.entries.values()].some(
			(e) => e.path === "複写/文書.md" && e.id !== docId,
		),
	).toBe(true);
	const libraryEtag = h.libraryTag();
	expect(
		(
			await h.service.manage(
				crypto.randomUUID(),
				{
					op: "batch",
					action: "delete",
					namespace: "eumenes",
					etag: libraryEtag,
					items: [
						{ kind: "folder", id: folderId },
						{ kind: "document", id: docId },
					],
				},
				signal(),
			)
		).state,
	).toBe("applied");
	expect(h.entries.has(docId)).toBe(false);
	expect(h.entries.has(otherId)).toBe(true);
	expect(h.commands.at(-1)).toMatchObject({ etag: libraryEtag });
});
test("unconfirmed changes are not resent, fence saves and apply, and GET-only confirmation is distinct", async () => {
	const h = managementFixture(),
		opened = await h.service.open(docId, signal()),
		id = crypto.randomUUID(),
		command = {
			op: "delete" as const,
			kind: "document" as const,
			id: docId,
			namespace: "eumenes",
			etag: tag("a"),
		};
	h.fail("unknown");
	expect((await h.service.manage(id, command, signal())).state).toBe("unknown");
	await h.service.manage(id, command, signal());
	expect(h.calls()).toBe(1);
	await expect(h.saveDoc(opened.id, opened.revision)).rejects.toThrow(
		"markdown_management_pending",
	);
	await expect(
		h.apply(opened.id, opened.revision, document("追記")),
	).rejects.toThrow("markdown_management_pending");
	expect((await h.service.check(id, signal())).state).toBe("unknown");
	h.entries.delete(docId);
	const done = await h.service.check(id, signal());
	expect(done.state).toBe("confirmed");
	expect(done.removedWorkspaceIds).toEqual([opened.id]);
	expect(h.calls()).toBe(1);
	await expect(
		h.apply(opened.id, opened.revision, document("古い入力")),
	).rejects.toThrow("markdown_not_found");
});
test("dirty work, changing library ETags and unsupported descendants reject before mutation", async () => {
	const h = managementFixture(),
		opened = await h.service.open(docId, signal());
	await h.apply(opened.id, opened.revision, document("入力"));
	await expect(
		h.service.manage(
			crypto.randomUUID(),
			{
				op: "delete",
				kind: "folder",
				id: folderId,
				namespace: "eumenes",
				etag: tag("b"),
				recursive: true,
			},
			signal(),
		),
	).rejects.toThrow("markdown_unsaved_changes");
	await expect(
		h.service.manage(
			crypto.randomUUID(),
			{
				op: "batch",
				action: "delete",
				namespace: "eumenes",
				etag: tag("0"),
				items: [{ kind: "document", id: docId }],
			},
			signal(),
		),
	).rejects.toThrow("revision_conflict");
	const f = h.entries.get(folderId)!;
	if (f.kind === "folder") f.hasUnsupportedEntries = true;
	await expect(
		h.service.manage(
			crypto.randomUUID(),
			{
				op: "copy",
				kind: "folder",
				id: folderId,
				namespace: "eumenes",
				etag: tag("b"),
				newId: `folder-${"f".repeat(32)}`,
				path: "コピー",
			},
			signal(),
		),
	).rejects.toThrow("unsupported_items");
	expect(h.calls()).toBe(0);
});
test("412 keeps the local document and does not silently adopt a new ETag", async () => {
	const h = managementFixture(),
		opened = await h.service.open(docId, signal());
	h.fail("conflict");
	const done = await h.service.manage(
		crypto.randomUUID(),
		{
			op: "delete",
			kind: "document",
			id: docId,
			namespace: "eumenes",
			etag: tag("a"),
		},
		signal(),
	);
	expect(done.state).toBe("conflict");
	expect((await h.service.check(done.id, signal())).state).toBe("conflict");
	expect(h.view(opened.id).remote?.etag).toBe(tag("a"));
	expect(h.calls()).toBe(1);
});
test("public staged management endpoint uses fixed input and returns the recorded result on duplicates", async () => {
	const h = managementFixture(),
		app = new Hono();
	registerMarkdown(app, h.service);
	const body = {
			requestId: crypto.randomUUID(),
			command: {
				op: "create-folder",
				id: `folder-${"f".repeat(32)}`,
				namespace: "eumenes",
				path: "空",
			},
		},
		stage = await app.request("/api/markdown/management-inputs", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	expect(stage.status).toBe(201);
	const { id: stageId } = await stage.json();
	const send = () =>
		app.request("/api/markdown/management", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ stageId }),
		});
	expect(await (await send()).json()).toMatchObject({ state: "applied" });
	expect(await (await send()).json()).toMatchObject({ state: "applied" });
	expect(h.calls()).toBe(1);
});
test("a lost success response is confirmed with GETs without resending the mutation", async () => {
	const h = managementFixture();
	h.dropAfter();
	const done = await h.service.manage(
		crypto.randomUUID(),
		{
			op: "delete",
			kind: "document",
			id: docId,
			namespace: "eumenes",
			etag: tag("a"),
		},
		signal(),
	);
	expect(done.state).toBe("confirmed");
	expect(h.calls()).toBe(1);
});
test("workspace adopts exactly the metadata checked against the expected content", async () => {
	const h = managementFixture(),
		opened = await h.service.open(docId, signal()),
		port = h.archive.management!,
		get = port.getEntry;
	let reads = 0;
	port.getEntry = async (kind, id, s) => {
		const e = await get(kind, id, s);
		if (id === docId && ++reads > 2 && e.kind === "document")
			return { ...e, etag: tag("f"), contentDigest: "0".repeat(64) };
		return e;
	};
	const done = await h.service.manage(
		crypto.randomUUID(),
		{
			op: "patch",
			kind: "document",
			id: docId,
			namespace: "eumenes",
			etag: tag("a"),
			title: "新題",
		},
		signal(),
	);
	expect(done.state).toBe("applied");
	expect(h.view(opened.id).remote?.etag).toBe(tag("e"));
	expect(reads).toBe(2);
});
test("batch move and copy adopt stable identities and leave opaque content untouched", async () => {
	const h = managementFixture(),
		opened = await h.service.open(docId, signal()),
		newDoc = `wiki-${"f".repeat(32)}`,
		newFolder = `folder-${"f".repeat(32)}`,
		empty = `folder-${"e".repeat(32)}`;
	await h.service.manage(
		crypto.randomUUID(),
		{ op: "create-folder", id: empty, namespace: "eumenes", path: "空" },
		signal(),
	);
	await h.service
		.manage(
			crypto.randomUUID(),
			{
				op: "batch",
				action: "move",
				namespace: "eumenes",
				etag: h.libraryTag(),
				items: [
					{ kind: "document", id: docId, path: "移動.md" },
					{ kind: "folder", id: empty, path: "空になった親" },
				],
			},
			signal(),
		)
		.then((r) => expect(r.state).toBe("applied"));
	expect(h.view(opened.id).remote?.path).toBe("移動.md");
	expect(h.view(opened.id).document).toEqual(opened.document);
	const result = await h.service.manage(
		crypto.randomUUID(),
		{
			op: "batch",
			action: "copy",
			namespace: "eumenes",
			etag: h.libraryTag(),
			items: [
				{ kind: "document", id: docId, path: "複製.md", newId: newDoc },
				{
					kind: "folder",
					id: empty,
					path: "複製フォルダー",
					newId: newFolder,
				},
			],
		},
		signal(),
	);
	expect(result.state).toBe("applied");
	expect(h.entries.has(newDoc)).toBe(true);
	expect(h.entries.has(newFolder)).toBe(true);
	expect(h.view(opened.id).sourceId).toBe(docId);
});
test("staging accepts 100 long Unicode destinations without packing them into an Artifact event", async () => {
	const h = managementFixture(),
		command = {
			op: "batch" as const,
			action: "copy" as const,
			namespace: "eumenes",
			etag: tag("a"),
			items: Array.from({ length: 100 }, (_, i) => ({
				kind: "folder" as const,
				id: `folder-${crypto.randomUUID().replaceAll("-", "")}`,
				newId: `folder-${crypto.randomUUID().replaceAll("-", "")}`,
				path: "😀".repeat(508) + String(i).padStart(4, "0"),
			})),
		};
	expect(JSON.stringify(command).length).toBeGreaterThan(100000);
	const stage = await h.service.stageManagement({
		requestId: crypto.randomUUID(),
		command,
	});
	const restored = await h.service.manageStaged(stage.id, signal());
	expect(restored.command).toEqual(command);
	expect(h.calls()).toBe(0);
});
test("overlapping moves and a manifest that changes while reading never dispatch", async () => {
	const h = managementFixture();
	await expect(
		h.service.manage(
			crypto.randomUUID(),
			{
				op: "batch",
				action: "move",
				namespace: "eumenes",
				etag: h.libraryTag(),
				items: [
					{ kind: "folder", id: folderId, path: "先" },
					{ kind: "document", id: docId, path: "別.md" },
				],
			},
			signal(),
		),
	).rejects.toThrow("overlapping_selection");
	const port = h.archive.management!,
		read = port.listLibrary;
	port.listLibrary = async (input, s) => {
		const page = await read(input, s);
		return input.path ? { ...page, etag: tag("f") } : page;
	};
	await expect(
		h.service.manage(
			crypto.randomUUID(),
			{
				op: "delete",
				kind: "folder",
				id: folderId,
				namespace: "eumenes",
				etag: tag("b"),
				recursive: true,
			},
			signal(),
		),
	).rejects.toThrow("revision_conflict");
	expect(h.calls()).toBe(0);
});
test("saving and collaborator ownership fence management before any external change", async () => {
	const h = managementFixture(),
		opened = await h.service.open(docId, signal());
	await h.saveDoc(opened.id, opened.revision);
	await expect(
		h.service.manage(
			crypto.randomUUID(),
			{
				op: "delete",
				kind: "document",
				id: docId,
				namespace: "eumenes",
				etag: tag("a"),
			},
			signal(),
		),
	).rejects.toThrow("markdown_save_in_progress");
	expect(h.calls()).toBe(0);
	const other = managementFixture(),
		doc = await other.service.open(docId, signal());
	await other.store.write((db) =>
		other.service.session.openInTransaction(db, {
			sessionId: crypto.randomUUID(),
			targetRef: doc.id,
		}),
	);
	await expect(
		other.service.manage(
			crypto.randomUUID(),
			{
				op: "delete",
				kind: "document",
				id: docId,
				namespace: "eumenes",
				etag: tag("a"),
			},
			signal(),
		),
	).rejects.toThrow("work_busy");
	expect(other.calls()).toBe(0);
});
test("a late mutation after cancellation is retained as unknown and only a later GET check adopts it", async () => {
	const h = managementFixture(),
		opened = await h.service.open(docId, signal()),
		controller = new AbortController(),
		release = Promise.withResolvers<void>(),
		started = Promise.withResolvers<void>(),
		port = h.archive.management!,
		manage = port.manage;
	port.manage = async (...args) => {
		started.resolve();
		await release.promise;
		return manage(...args);
	};
	const id = crypto.randomUUID(),
		pending = h.service.manage(
			id,
			{
				op: "delete",
				kind: "document",
				id: docId,
				namespace: "eumenes",
				etag: tag("a"),
			},
			controller.signal,
		);
	await started.promise;
	controller.abort();
	release.resolve();
	expect((await pending).state).toBe("unknown");
	expect(h.view(opened.id).sourceId).toBe(docId);
	expect((await h.service.check(id, signal())).state).toBe("confirmed");
	expect(h.calls()).toBe(1);
});
test("a fresh service reads the persisted unknown request and can only confirm it without another mutation", async () => {
	const { openStore } = await import("../../../infrastructure/sqlite"),
		{ migrations: queueMigrations } = await import("../../queue"),
		{ migrations } = await import(".."),
		{ createLibraryManagement } = await import("../service/library-management");
	const h = managementFixture(),
		id = crypto.randomUUID(),
		command = {
			op: "delete" as const,
			kind: "document" as const,
			id: docId,
			namespace: "eumenes",
			etag: tag("a"),
		};
	h.fail("unknown");
	await h.service.manage(id, command, signal());
	await h.queue.close(20);
	await h.store.close();
	const reopened = openStore(h.file, [...queueMigrations, ...migrations]);
	try {
		const service = createLibraryManagement(reopened, h.archive);
		expect((await service.operations())[0]).toMatchObject({
			id,
			state: "unknown",
		});
		expect((await service.manage(id, command, signal())).state).toBe("unknown");
		expect(h.calls()).toBe(1);
		h.entries.delete(docId);
		expect((await service.check(id, signal())).state).toBe("confirmed");
		expect(h.calls()).toBe(1);
	} finally {
		await reopened.close();
	}
});
