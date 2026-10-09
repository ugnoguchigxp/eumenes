import { expect, test } from "bun:test";
import { WorldHostStateError } from "..";
import {
	ACCESS,
	NOW,
	SCOPE,
	addMessage,
	adoptPlan,
	claim,
	count,
	currentRef,
	entityOp,
	registerClaim,
	request,
	withHarness,
} from "./fixture";
import { buildWorldSlice, toSliceReceipt } from "eumenes-world-model";
import { createHash } from "node:crypto";

const hasher = (bytes: Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");

test("schema mismatch disables World without breaking anything else", async () => {
	await withHarness(async (h) => {
		expect(h.world.status()).toEqual({
			enabled: true,
			schema: "current",
			usable: true,
		});
		await h.world.apply(entityOp());
		await addMessage(h, "m1", "text");
		// A drifted migration record (hash edited) means the schema is not the pinned one.
		await h.store.write((db) => {
			db.query("UPDATE world_schema_info SET sha256 = ? WHERE ordinal = 2").run(
				"0".repeat(64),
			);
		});
		expect(h.world.status()).toEqual({
			enabled: true,
			schema: "incompatible",
			usable: false,
		});
		const before = count(h, "world_operation");
		expect(await h.world.apply(entityOp("e-2"))).toEqual({
			status: "blocked",
			reasonCode: "SCHEMA_INCOMPATIBLE",
			stage: "world",
		});
		// Protective operations are blocked too: World tables are not touched at all.
		expect(
			await h.world.apply(
				request("inv", {
					kind: "invalidate",
					reasonCode: "SOURCE_RETRACTED",
					targets: [],
					sourceKeys: ["x"],
				}),
			),
		).toMatchObject({ status: "blocked", reasonCode: "SCHEMA_INCOMPATIBLE" });
		expect(
			await h.world.read({ access: ACCESS, scope: SCOPE, asOf: NOW }),
		).toMatchObject({ status: "blocked", reasonCode: "SCHEMA_INCOMPATIBLE" });
		expect(count(h, "world_operation")).toBe(before);
		// Everything else keeps working: conversation and the host state.
		await addMessage(h, "m2", "still fine");
		expect(
			h.store.read((db) => h.conversation.sourceInTransaction(db, "m2")).state,
		).toBe("available");
		await h.world.setEnabled(false);
		expect(h.world.status().enabled).toBe(false);
	});
});

test("a future schema (an unknown later migration row) also blocks World", async () => {
	await withHarness(async (h) => {
		await h.store.write((db) => {
			db.query(
				"INSERT INTO world_schema_info (ordinal, migration_id, sha256) VALUES (99, 'future-099', ?)",
			).run("1".repeat(64));
		});
		expect(h.world.status().schema).toBe("incompatible");
		expect(await h.world.apply(entityOp())).toMatchObject({
			status: "blocked",
			reasonCode: "SCHEMA_INCOMPATIBLE",
		});
	});
});

test("OFF: normal changes are refused but corrections and forgetting keep their way in", async () => {
	await withHarness(
		async (h) => {
			expect(h.world.status().enabled).toBe(false);
			expect(await h.world.apply(entityOp())).toMatchObject({
				reasonCode: "WORLD_DISABLED",
			});
			const protective = await h.world.apply(
				request("inv", {
					kind: "invalidate",
					reasonCode: "SOURCE_RETRACTED",
					targets: [],
					sourceKeys: ['["conversation","message","m1","text"]'],
				}),
			);
			expect(protective.status).not.toBe("blocked");
			expect(count(h, "world_entity")).toBe(0);
		},
		{},
		{ enabled: false },
	);
});

test("hostChecks come from the writer's own database: epochs and policy move the receipts", async () => {
	await withHarness(async (h) => {
		await h.world.apply(entityOp());
		await addMessage(h, "m1", "text");
		await h.world.apply(
			registerClaim("c-1", claim("claim-1", [currentRef(h, "m1")])),
		);
		await h.world.apply(
			request("ad-1", {
				kind: "assertion.transition",
				plan: adoptPlan("claim-1", 1),
			}),
		);
		const receiptOf = async () => {
			const read = await h.world.read({
				access: ACCESS,
				scope: SCOPE,
				asOf: NOW,
			});
			if (read.status !== "ready") throw new Error(JSON.stringify(read));
			const slice = buildWorldSlice(
				{ contractVersion: 1, snapshot: read.snapshot, request: {} },
				hasher,
			);
			if (!slice.ok) throw new Error(slice.code);
			return toSliceReceipt(slice.value);
		};
		const check = (receipt: unknown) =>
			h.world.validateUsage(receipt, { access: ACCESS, scope: SCOPE });

		let receipt = await receiptOf();
		expect(receipt.forgetEpoch).toBe("forget-0");
		expect(receipt.restoreEpoch).toBe("restore-0");
		expect((await check(receipt)).status).toBe("valid");

		// Forget epoch (per Scope) moves: the receipt is refused.
		await h.store.write((db) => h.world.bumpForgetEpochInWriter(db, SCOPE));
		expect((await check(receipt)).status).toBe("blocked");
		// Another Scope's epoch is not touched.
		expect(
			h.store.read((db) =>
				h.world.forgetEpoch(db, {
					principal: SCOPE.principal,
					scopeKey: "other",
				}),
			),
		).toBe("forget-0");
		receipt = await receiptOf();
		expect(receipt.forgetEpoch).not.toBe("forget-0");
		expect((await check(receipt)).status).toBe("valid");

		// Restore epoch moves: refused again.
		await h.store.write((db) => h.world.bumpRestoreEpochInWriter(db));
		expect((await check(receipt)).status).toBe("blocked");
		receipt = await receiptOf();
		expect((await check(receipt)).status).toBe("valid");

		// Policy revision is the memory service's access() revision.
		await h.store.write((db) => {
			db.exec(
				"UPDATE memory_host_settings SET revision = revision + 1 WHERE id = 1",
			);
		});
		expect((await check(receipt)).status).toBe("blocked");
	});
});

test("feed cursors are valid only for the restore epoch that issued them", async () => {
	await withHarness(async (h) => {
		const read = (feed: "source" | "memory") =>
			h.store.read((db) => h.world.feedCursor(db, feed, SCOPE));
		expect(read("source")).toMatchObject({ cursor: null, stale: false });
		await h.store.write((db) => {
			h.world.saveFeedCursorInWriter(db, "source", SCOPE, "c1.abc");
			h.world.saveFeedCursorInWriter(db, "memory", SCOPE, "42");
		});
		expect(read("source")).toMatchObject({ cursor: "c1.abc", stale: false });
		expect(read("memory")).toMatchObject({ cursor: "42" });
		const issued = read("source").restoreEpoch;
		await h.store.write((db) => h.world.bumpRestoreEpochInWriter(db));
		// Restart from the beginning under the new epoch; the old position is not reused.
		const after = read("source");
		expect(after).toMatchObject({ cursor: null, stale: true });
		expect(after.restoreEpoch).not.toBe(issued);
		await h.store.write((db) =>
			h.world.saveFeedCursorInWriter(db, "source", SCOPE, "c1.def"),
		);
		expect(read("source")).toMatchObject({ cursor: "c1.def", stale: false });
		expect(read("memory")).toMatchObject({ cursor: null, stale: true });
	});
});

test("host state writes need the writer's transaction", async () => {
	await withHarness(async (h) => {
		expect(() =>
			h.store.read((db) => h.world.bumpRestoreEpochInWriter(db)),
		).toThrow(WorldHostStateError);
		expect(() =>
			h.store.read((db) => h.world.applyInWriter(db, entityOp())),
		).toThrow(WorldHostStateError);
	});
});
