import { expect, test } from "bun:test";
import { Hono } from "hono";
import { sha256Hex } from "../../../infrastructure/digest";
import { createWorldDocuments, registerWorldDocuments } from "..";
import { createWorldMaintenance } from "../service/maintenance";
import {
	ACCESS,
	NOW,
	PURPOSE,
	SCOPE,
	addMessage,
	claim,
	currentRef,
	entityOp,
	registerClaim,
	withHarness,
} from "./fixture";

const content = "修理対象の部品は交換前に記録する。";
const document = {
	id: "owner-doc",
	revision: "v1",
	title: "修理記録",
	collection: "project",
	manifestDigest: "a".repeat(64),
	content,
	digest: `sha256:${sha256Hex(content)}`,
};

test("document archive is scoped and reversible; all regular reads and previously obtained citations stop using it", async () => {
	await withHarness(async (h) => {
		const docs = createWorldDocuments(h.store);
		await docs.import(SCOPE, document);
		const request = {
			active: false,
			refs: [
				{ kind: "document", id: document.id, revision: document.revision },
			],
		};
		expect(docs.maintenance.preview(SCOPE, request).items[0]?.changed).toBe(
			true,
		);
		expect(
			h.store.readSnapshot((db) =>
				docs.lookupInTransaction(db, SCOPE, { query: "修理" }),
			),
		).toMatchObject({ kind: "search", documents: [{ id: document.id }] });
		await docs.maintenance.apply(SCOPE, request);
		expect(
			h.store.readSnapshot((db) =>
				docs.lookupInTransaction(db, SCOPE, { query: "修理" }),
			),
		).toEqual({ kind: "search", documents: [] });
		expect(
			h.store.readSnapshot((db) => docs.pageInTransaction(db, SCOPE)),
		).toMatchObject({ total: 0 });
		expect(() =>
			h.store.readSnapshot((db) =>
				docs.lookupInTransaction(db, SCOPE, { documentId: document.id }),
			),
		).toThrow("not_found");
		expect(
			h.store.read((db) =>
				docs.isCurrentInTransaction(db, SCOPE, document.id, document.revision),
			),
		).toBe(false);
		await expect(
			docs.maintenance.apply(
				{ ...SCOPE, scopeKey: "other" },
				{ ...request, active: true },
			),
		).rejects.toThrow("maintenance_conflict");
		await docs.maintenance.apply(SCOPE, { ...request, active: true });
		expect(
			h.store.readSnapshot((db) =>
				docs.lookupInTransaction(db, SCOPE, { documentId: document.id }),
			),
		).toMatchObject({ kind: "document", text: content });
		expect(
			h.store.read((db) =>
				docs.isCurrentInTransaction(db, SCOPE, document.id, document.revision),
			),
		).toBe(true);
	});
});

test("World claims keep their original revision and evidence while normal snapshots exclude them", async () => {
	await withHarness(async (h) => {
		await addMessage(h, "m1", "修理台は利用できます");
		expect((await h.world.apply(entityOp())).status).toBe("applied");
		expect(
			(
				await h.world.apply(
					registerClaim(
						"claim-create",
						claim("claim-1", [currentRef(h, "m1")]),
					),
				)
			).status,
		).toBe("applied");
		const management = createWorldMaintenance(h.store, h.world, PURPOSE);
		const input = {
			active: false,
			refs: [{ kind: "claim", id: "claim-1", revision: "1" }],
		};
		const read = () =>
			h.store.readSnapshot((db) =>
				h.world.readSnapshot(db, { access: ACCESS, scope: SCOPE, asOf: NOW }),
			);
		const before = read();
		expect(before.status).toBe("ready");
		await management.apply(SCOPE, input);
		const archived = read();
		expect(archived.status === "ready" && archived.snapshot.assertions).toEqual(
			[],
		);
		expect(management.list(SCOPE).items).toMatchObject([
			{ id: "claim-1", revision: "1", active: false },
		]);
		await management.apply(SCOPE, { ...input, active: true });
		expect(read()).toEqual(before);
	});
});

test("a stale member rejects the whole archive batch; owner API rejects unknown scope and empty selection", async () => {
	await withHarness(async (h) => {
		const docs = createWorldDocuments(h.store);
		await docs.import(SCOPE, document);
		await expect(
			docs.maintenance.apply(SCOPE, {
				active: false,
				refs: [
					{ kind: "document", id: document.id, revision: document.revision },
					{ kind: "document", id: "missing", revision: "v1" },
				],
			}),
		).rejects.toThrow("maintenance_conflict");
		expect(
			h.store.read((db) =>
				docs.isCurrentInTransaction(db, SCOPE, document.id, document.revision),
			),
		).toBe(true);
		const app = new Hono();
		registerWorldDocuments(app, docs, () => SCOPE);
		const response = await app.request("/api/world/maintenance/apply", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ active: false, refs: [], scopeKey: "other" }),
		});
		expect(response.status).toBe(400);
	});
});
