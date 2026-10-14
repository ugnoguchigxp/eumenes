import { expect, test } from "bun:test";
import { worldHasContent } from "..";
import { insertIntake } from "../repository/lifecycle";
import { NOW, SCOPE, entityOp, withHarness } from "./fixture";

test("worldHasContent: false on a fresh database, true once World holds an entity, independent of the ON/OFF flag", async () => {
	await withHarness(async (h) => {
		expect(worldHasContent(h.store)).toBe(false);
		expect((await h.world.apply(entityOp())).status).toBe("applied");
		expect(worldHasContent(h.store)).toBe(true);
		// OFF still reports the content: forgetting has to keep reaching it.
		await h.world.setEnabled(false);
		expect(worldHasContent(h.store)).toBe(true);
	});
});

test("worldHasContent: a forget intake alone counts as content", async () => {
	await withHarness(async (h) => {
		expect(worldHasContent(h.store)).toBe(false);
		await h.store.write((db) =>
			insertIntake(
				db,
				{
					forgetId: "forget-content-1",
					principal: SCOPE.principal,
					scopeKey: SCOPE.scopeKey,
					memoryForgetId: null,
					memoryFinal: true,
					reasonCode: "FORGET_REQUESTED",
					origin: "request",
					roots: [],
					rootsDigest: "0".repeat(64),
					state: "journaled",
				},
				NOW,
			),
		);
		expect(worldHasContent(h.store)).toBe(true);
	});
});
