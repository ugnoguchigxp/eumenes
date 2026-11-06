import { expect, test } from "bun:test";
import { createWorldHostGate } from "..";
import { entityOp, request, withHarness } from "./fixture";

const input = () =>
	request("initial-receipt", {
		kind: "inbox.receive",
		feed: {
			scopeKeys: ["profile:owner"],
			kind: "source",
			cursorRestoreEpoch: "restore-0",
		},
		event: {
			eventId: "initial-event",
			seq: 1,
			payload: { source: "metadata-only" },
		},
		receivedCursor: "initial-cursor",
	});

test("initial staging permits only inbox receipts before completion and still enforces the startup gate", async () => {
	const gate = createWorldHostGate();
	await withHarness(
		async (h) => {
			const stage = (op = input()) =>
				h.store.write((db) => h.world.receiveInitialInputInWriter(db, op));
			expect(await stage()).toMatchObject({
				status: "blocked",
				reasonCode: "WORLD_RECOVERY_REQUIRED",
			});
			gate.open();
			expect(await h.world.apply(input())).toMatchObject({
				status: "blocked",
				reasonCode: "WORLD_DISABLED",
			});
			expect(await stage(entityOp())).toMatchObject({
				status: "rejected",
				reasonCode: "INVALID_INPUT",
			});
			expect((await stage()).status).toBe("applied");
			expect((await stage()).status).toBe("no_op");
			expect(h.world.status().enabled).toBe(false);
			await h.world.markInitialSyncComplete();
			expect(await stage()).toMatchObject({
				status: "rejected",
				reasonCode: "INVALID_INPUT",
			});
		},
		{ gate },
		{ enabled: false, initialSync: false },
	);
});
