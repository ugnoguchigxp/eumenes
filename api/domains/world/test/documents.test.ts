import { expect, test } from "bun:test";
import { Hono } from "hono";
import { answerError } from "../../../application/app";
import { createWorldDocuments, registerWorldDocuments } from "..";
import { sha256Hex } from "../../../infrastructure/digest";
import { SCOPE, withHarness, type Harness } from "./fixture";

const content = JSON.stringify({
	text: "西工房の資料。規程の閾値は観測値ではない。",
	review: "未再検証",
});
const document = {
	id: "doc-1",
	revision: "seed-v1",
	title: "収集規程",
	collection: "collection-1",
	manifestDigest: "a".repeat(64),
	content,
	digest: `sha256:${sha256Hex(content)}`,
};

const withdraw = (h: Harness, id: string) =>
	h.store.write((db) =>
		db
			.query(
				`UPDATE world_host_document SET withdrawn=1, content='', title='', collection='', manifest_digest='' WHERE principal=?1 AND scope_key=?2 AND id=?3`,
			)
			.run(SCOPE.principal, SCOPE.scopeKey, id),
	);

test("collected documents: immutable import, scope isolation, content integrity and withdrawal tombstone", async () => {
	await withHarness(async (h) => {
		const docs = createWorldDocuments(h.store);
		expect(await docs.import(SCOPE, document)).toEqual({ status: "inserted" });
		expect(await docs.import(SCOPE, document)).toEqual({ status: "unchanged" });
		await expect(
			docs.import(SCOPE, { ...document, digest: `sha256:${"0".repeat(64)}` }),
		).rejects.toThrow("digest_mismatch");
		await expect(
			docs.import(SCOPE, { ...document, title: "改竄" }),
		).rejects.toThrow("revision_conflict");
		const lookup = (raw: unknown, scope = SCOPE) =>
			h.store.readSnapshot((db) => docs.lookupInTransaction(db, scope, raw));
		expect(lookup({ query: "西工房" })).toMatchObject({
			documents: [{ id: "doc-1" }],
		});
		expect(
			lookup({ query: "西工房" }, { ...SCOPE, principal: "other" }),
		).toMatchObject({ documents: [] });
		expect(() =>
			lookup({ documentId: "doc-1" }, { ...SCOPE, scopeKey: "other" }),
		).toThrow("not_found");
		expect(lookup({ documentId: "doc-1" })).toMatchObject({
			text: content,
			complete: true,
		});
		expect(() => lookup({ query: "西", documentId: "doc-1" })).toThrow(
			"invalid_input",
		);
		expect(
			h.store.readSnapshot((db) =>
				docs.isCurrentInTransaction(db, SCOPE, "doc-1", "seed-v1"),
			),
		).toBe(true);
		await withdraw(h, "doc-1");
		expect(
			h.store.readSnapshot((db) =>
				docs.isCurrentInTransaction(db, SCOPE, "doc-1", "seed-v1"),
			),
		).toBe(false);
		expect(() => lookup({ documentId: "doc-1" })).toThrow("not_found");
		await expect(docs.import(SCOPE, document)).rejects.toThrow(
			"document_withdrawn",
		);
	});
});

test("owner API imports only host scope, paged Unicode reads reconstruct all text", async () => {
	await withHarness(async (h) => {
		const docs = createWorldDocuments(h.store);
		const app = new Hono();
		app.onError(answerError);
		registerWorldDocuments(app, docs, () => SCOPE);
		const post = (body: unknown) =>
			app.request("/api/world/documents", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
		expect((await post({ ...document, principal: "other" })).status).toBe(400);
		const long = "条件🧭".repeat(3000);
		expect(
			(
				await post({
					...document,
					content: long,
					digest: `sha256:${sha256Hex(long)}`,
				})
			).status,
		).toBe(200);
		let offset = 0;
		let reconstructed = "";
		for (;;) {
			const result = h.store.readSnapshot((db) =>
				docs.lookupInTransaction(db, SCOPE, { documentId: "doc-1", offset }),
			);
			if (result.kind !== "document") throw new Error("expected_document");
			expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(8192);
			expect(result.complete).toBe(false);
			reconstructed += result.text;
			if (result.nextOffset === undefined) break;
			offset = result.nextOffset;
		}
		expect(reconstructed).toBe(long);
		await withdraw(h, "doc-1");
		expect((await post(document)).status).toBe(409);
	});
});

test("search metadata fits the research operation budget and advances without dropping matches", async () => {
	await withHarness(async (h) => {
		const docs = createWorldDocuments(h.store);
		for (let i = 0; i < 15; i++)
			await docs.import(SCOPE, {
				...document,
				id: `long-${String(i).padStart(2, "0")}`,
				title: "収集資料🧭".repeat(40),
				collection: "資料群".repeat(60),
			});
		let offset = 0;
		const ids = new Set<string>();
		for (;;) {
			const result = h.store.readSnapshot((db) =>
				docs.lookupInTransaction(db, SCOPE, { query: "西工房", offset }),
			);
			if (result.kind !== "search") throw new Error("expected_search");
			expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(2600);
			for (const item of result.documents) ids.add(item.id);
			if (result.nextOffset === undefined) break;
			expect(result.nextOffset).toBeGreaterThan(offset);
			offset = result.nextOffset;
		}
		expect(ids.size).toBe(15);
	});
});

test("owner browsing pages all 1000 documents, searches beyond the first page, isolates scopes and clamps a removed final page", async () => {
	await withHarness(async (h) => {
		const docs = createWorldDocuments(h.store);
		for (let i = 0; i < 1000; i++) {
			const id = `doc-${String(i).padStart(4, "0")}`;
			const text = i === 999 ? "needle-last" + "文".repeat(3000) : content;
			await docs.import(SCOPE, {
				...document,
				id,
				title: id,
				content: text,
				digest: `sha256:${sha256Hex(text)}`,
			});
		}
		const page = (scope: typeof SCOPE, raw: unknown = {}) =>
			h.store.readSnapshot((db) => docs.pageInTransaction(db, scope, raw));
		const ids = new Set<string>();
		for (let pageIndex = 0; pageIndex < 20; pageIndex++) {
			const result = page(SCOPE, { pageIndex, pageSize: 50, sort: "id" });
			expect(result.total).toBe(1000);
			expect(result.pageIndex).toBe(pageIndex);
			expect(result.items).toHaveLength(50);
			for (const row of result.items) ids.add(row.id);
		}
		expect(ids.size).toBe(1000);
		const found = page(SCOPE, { q: "needle-last" });
		expect(found.total).toBe(1);
		expect(found.items[0]?.id).toBe("doc-0999");
		expect([...found.items[0]!.excerpt]).toHaveLength(2048);
		expect(found.items[0]!.contentLength).toBe(3011);
		expect(page({ ...SCOPE, principal: "other" }).total).toBe(0);
		expect(page({ ...SCOPE, scopeKey: "other" }).total).toBe(0);
		expect(page(SCOPE, { sort: "title", desc: true }).items[0]?.id).toBe(
			"doc-0999",
		);
		expect(
			page(SCOPE, { pageIndex: 99, pageSize: 10, sort: "id" }),
		).toMatchObject({
			total: 1000,
			pageIndex: 99,
			items: Array.from({ length: 10 }, (_, i) => ({ id: `doc-099${i}` })),
		});
		for (const raw of [
			{ pageSize: 1000 },
			{ pageIndex: -1 },
			{ sort: "content" },
			{ principal: "other" },
			{ desc: "invalid" },
		])
			expect(() => page(SCOPE, raw)).toThrow();
		await withdraw(h, "doc-0999");
		expect(page(SCOPE, { q: "needle-last", pageIndex: 99 })).toMatchObject({
			total: 0,
			pageIndex: 0,
			items: [],
		});
	});
});
