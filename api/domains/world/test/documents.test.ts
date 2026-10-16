import { expect, test } from "bun:test";
import { Hono } from "hono";
import { createWorldDocuments, registerWorldDocuments } from "..";
import { sha256Hex } from "../../../infrastructure/digest";
import { SCOPE, withHarness } from "./fixture";

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
		await docs.withdraw(SCOPE, "doc-1");
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
		expect(
			(await app.request("/api/world/documents/doc-1", { method: "DELETE" }))
				.status,
		).toBe(200);
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
			const result = docs.lookup(SCOPE, { query: "西工房", offset });
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
