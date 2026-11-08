import { expect, test } from "bun:test";
import { fixture, archived } from "./workspace.fixture";
import { ArchiveFailure } from "../contracts";
import type { GeneratedInput } from "../contracts/generated";
import { waitFor } from "../../../infrastructure/wait-for";
import { createMarkdownResourceAdapter } from "..";

function setup(options: { localFailure?: boolean } = {}) {
	const h = fixture(),
		local = new Map<string, string>();
	let valid = true;
	h.service.generated.configure({
		validInTransaction: () => valid,
		async writeLocal(input) {
			if (options.localFailure) throw new Error("scratch_capacity");
			local.set(input.id, input.markdown);
			return `eumenes://scratch/${input.id}`;
		},
		hasLocal: (id) => local.has(id),
		forgetLocal: (id) => {
			local.delete(id);
		},
	});
	const input: GeneratedInput = {
		id: crypto.randomUUID(),
		ownerRef: "owner:0",
		sourceRunId: "source",
		conversationId: "main",
		title: "日本語の比較調査",
		markdown: "\uFEFF# 日本語の比較調査\r\n[資料](https://example.com)  \r\n",
		namespace: "eumenes",
		path: "research/日本語の比較調査.md",
	};
	const current = () =>
		h.store.read((db) =>
			h.service.generated.currentInTransaction(db, input.id),
		);
	const start = async () => {
		await h.store.write((db) =>
			h.service.generated.startInTransaction(db, input),
		);
		h.queue.start();
		await waitFor(() => current()?.state === "settled");
		return current()!;
	};
	return {
		...h,
		input,
		local,
		current,
		start,
		revoke: () => {
			valid = false;
		},
	};
}

test("generated Markdown is saved without a session, retains exact text, and replays the same receipt", async () => {
	const h = setup(),
		value = await h.start();
	expect(value).toMatchObject({
		title: h.input.title,
		local: { state: "saved" },
		archive: { state: "saved" },
	});
	expect(h.local.get(h.input.id)).toBe(h.input.markdown);
	const remote = await h.archive.read(
		value.archive.sourceId!,
		AbortSignal.timeout(1000),
	);
	expect(remote).toMatchObject({
		markdown: h.input.markdown,
		recovery: "",
		entry: { title: h.input.title, namespace: "eumenes", path: h.input.path },
	});
	expect(
		h.store.read((db) =>
			db.query("SELECT count(*) AS n FROM markdown_sessions").get(),
		),
	).toEqual({ n: 0 });
	await h.store.write((db) =>
		h.service.generated.startInTransaction(db, h.input),
	);
	expect(h.calls()).toBe(1);
	await expect(
		h.store.write((db) =>
			h.service.generated.startInTransaction(db, {
				...h.input,
				markdown: "違う本文",
			}),
		),
	).rejects.toThrow("request_conflict");
	const resources = createMarkdownResourceAdapter(h.store),
		result = { document: value };
	expect(
		h.store.read((db) =>
			resources.fromResultInTransaction(db, result, {
				conversationId: "main",
				runId: "source",
			}),
		),
	).toHaveLength(1);
	expect(
		h.store.read((db) =>
			resources.fromResultInTransaction(db, result, {
				conversationId: "other",
				runId: "source",
			}),
		),
	).toEqual([]);
	expect(
		h.store.read((db) =>
			resources.fromResultInTransaction(db, result, {
				conversationId: "main",
				runId: "other",
			}),
		),
	).toEqual([]);
	expect(
		await h.service.preview(value.archive.sourceId!, AbortSignal.timeout(1000)),
	).toMatchObject({ document: null, markdown: h.input.markdown });
	h.local.clear();
	expect(h.current()?.local.state).toBe("expired");
});

test("local capacity failure does not prevent an independent Docling save", async () => {
	const h = setup({ localFailure: true });
	expect(await h.start()).toMatchObject({
		local: { state: "failed", code: "scratch_capacity" },
		archive: { state: "saved" },
	});
});

test("unavailable Docling preserves the local file; rejected namespace never sends a PUT", async () => {
	for (const kind of ["unavailable", "namespace"] as const) {
		const h = setup();
		if (kind === "unavailable")
			h.archive.capabilities = async () => {
				throw new ArchiveFailure("markdown_archive_unavailable", "failed");
			};
		else
			h.archive.list = async () => ({
				namespaces: ["other"],
				items: [],
				nextCursor: null,
			});
		expect(await h.start()).toMatchObject({
			local: { state: "saved" },
			archive: { state: "unsaved" },
		});
		expect(h.calls()).toBe(0);
	}
});

test("lost PUT response is confirmed by GET without resending or changing its ID", async () => {
	const h = setup();
	let puts = 0;
	h.archive.save = async (input) => {
		puts++;
		h.snapshots.set(input.sourceId, archived(input));
		throw new Error("response_lost");
	};
	expect(await h.start()).toMatchObject({ archive: { state: "saved" } });
	expect(puts).toBe(1);
});

test("an unconfirmed PUT stays unknown and repeated requests do not retry it", async () => {
	const h = setup();
	let puts = 0;
	h.archive.save = async () => {
		puts++;
		throw new Error("response_lost");
	};
	expect(await h.start()).toMatchObject({
		local: { state: "saved" },
		archive: { state: "unknown" },
	});
	await h.store.write((db) =>
		h.service.generated.startInTransaction(db, h.input),
	);
	expect(puts).toBe(1);
});

test("cancelled or forgotten output cannot be saved or adopted after a delayed local write", async () => {
	const h = setup();
	let release!: () => void,
		entered = false,
		removed = false;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	h.service.generated.configure({
		validInTransaction: () => true,
		async writeLocal(input) {
			entered = true;
			await held;
			h.local.set(input.id, input.markdown);
			return `eumenes://scratch/${input.id}`;
		},
		hasLocal: (id) => h.local.has(id),
		forgetLocal: (id) => {
			if (h.local.has(id)) removed = true;
			h.local.delete(id);
		},
	});
	await h.store.write((db) =>
		h.service.generated.startInTransaction(db, h.input),
	);
	h.queue.start();
	await waitFor(() => entered);
	await h.store.write((db) =>
		h.service.generated.cancelInTransaction(db, h.input.id, true),
	);
	release();
	await waitFor(() => removed);
	expect(h.current()).toBeNull();
	expect(h.local.size).toBe(0);
	expect(h.calls()).toBe(0);
});

test("connection change during PUT never adopts a result from the previous binding", async () => {
	const h = setup();
	h.archive.save = async (input) => {
		h.change();
		return archived(input).entry;
	};
	expect(await h.start()).toMatchObject({
		local: { state: "saved" },
		archive: { state: "unknown", code: "markdown_archive_connection_changed" },
	});
});

test("the status check confirms a previously unknown save using GET only", async () => {
	const h = setup();
	let frozen: Parameters<typeof h.archive.save>[0] | undefined,
		puts = 0;
	h.archive.save = async (input) => {
		frozen = input;
		puts++;
		throw new Error("response_lost");
	};
	expect((await h.start()).archive.state).toBe("unknown");
	h.snapshots.set(frozen!.sourceId, archived(frozen!));
	expect(
		await h.service.generated.reconcile(h.input.id, AbortSignal.timeout(2000)),
	).toMatchObject({ archive: { state: "saved", sourceId: frozen!.sourceId } });
	expect(puts).toBe(1);
});

test("a changed remote document is a conflict and is never overwritten", async () => {
	const h = setup();
	let puts = 0;
	h.archive.save = async (input) => {
		puts++;
		h.snapshots.set(
			input.sourceId,
			archived({ ...input, markdown: "別の文書" }),
		);
		throw new ArchiveFailure("markdown_archive_conflict", "conflict", 412);
	};
	expect((await h.start()).archive.state).toBe("conflict");
	expect(puts).toBe(1);
});
