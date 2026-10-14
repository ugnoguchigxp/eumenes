import { afterEach, expect, test } from "bun:test";
import type { WorldApplyRequest } from "../../world";
import { createWorldView } from "../service/world-view";
import { ACCESS, NOW, PURPOSE, SCOPE, openRealWorld } from "./world.real";

// World's view for a forget request, over the REAL World: the entities the request names are offered whatever the
// letter case or width of the words (World's own alias lookup is a case-sensitive prefix match).

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
	await cleanup?.();
	cleanup = undefined;
});

test("an entity named in the request is offered whatever its letter case, and the others are not matched by chance", async () => {
	const opened = await openRealWorld({});
	cleanup = () => opened.cleanup();
	expect((await opened.registerEntity()).status).toBe("applied");
	let n = 0;
	for (const [name, aliases] of [
		["Eumenes", []],
		["LARM", ["ラーム"]],
		["steward", []],
	] as const)
		expect(
			(
				await opened.world.apply({
					access: ACCESS,
					scope: SCOPE,
					operationKey: `e-${++n + 1}`,
					clock: NOW,
					operation: {
						kind: "entity.register",
						entity: {
							id: `ent-${name}`,
							displayName: name,
							aliases: [...aliases],
							externalRefs: [],
						},
					},
				} as WorldApplyRequest)
			).status,
		).toBe("applied");
	const view = createWorldView({
		service: opened.world,
		purpose: PURPOSE,
		scope: SCOPE,
	});
	const namesFor = (...texts: string[]) =>
		opened.store.readSnapshot(
			(db) =>
				view(db, texts, NOW)
					?.entities.map((entity) => entity.name)
					.sort() ?? null,
		);

	const exact = await namesFor("Eumenes と LARM のことは全部忘れてください。");
	expect(exact).toEqual(expect.arrayContaining(["Eumenes", "LARM"]));
	// Lower case, full width, and an alias: found by the host, which folds what World compares as typed.
	expect(await namesFor("larm について")).toEqual(["LARM"]);
	expect(await namesFor("ｅｕｍｅｎｅｓ のこと")).toContain("Eumenes");
	expect(await namesFor("ラームを忘れて")).toContain("LARM");
});
