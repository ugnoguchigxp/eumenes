/**
 * Topic targets: the known targets a turn names are found by a deterministic name/alias match, and dialogue gets
 * only their display names (never a claim, never an id). Fixture-grade on a REAL host store.
 */
import { expect, test } from "bun:test";
import { createWorldContextNames } from "..";
import { matchTopicEntities } from "../service/context-topics";
import {
	PURPOSE,
	addMessage,
	adoptPlan,
	claim,
	currentRef,
	entityOp,
	registerClaim,
	request,
	withHarness,
	type Harness,
} from "./fixture";

const entity = (id: string, displayName: string, aliases: string[] = []) => ({
	id,
	displayName,
	aliases,
});

test("match: longest name first, NFKC and case folded, ambiguous aliases skipped, at most five", () => {
	const all = [
		entity("e1", "Eumenes"),
		entity("e2", "Eumenes Memory", ["記憶担当"]),
		entity("e3", "ゲートウェイ", ["共通"]),
		entity("e4", "別の窓口", ["共通"]),
		entity("e5", "AI"),
		entity("e6", "天気"),
	];
	// The longer name covers its characters: "Eumenes" inside "Eumenes Memory" is not a second match.
	expect(matchTopicEntities(all, ["eumenes memory の状態は？"])).toEqual([
		"e2",
	]);
	// NFKC: full-width letters match; trim and case do not matter.
	expect(matchTopicEntities(all, ["  ＥＵＭＥＮＥＳ  "])).toEqual(["e1"]);
	// A name shared by two entities is ambiguous and never matched (its owners stay reachable by their own names).
	expect(matchTopicEntities(all, ["共通の件"])).toEqual([]);
	expect(matchTopicEntities(all, ["ゲートウェイと共通"])).toEqual(["e3"]);
	// A Latin name inside a longer word is not a mention.
	expect(matchTopicEntities(all, ["I said it"])).toEqual([]);
	expect(matchTopicEntities(all, ["AI の話"])).toEqual(["e5"]);
	// The current wording comes before the earlier one; nothing named: nothing.
	expect(matchTopicEntities(all, ["天気は？", "Eumenes は"])).toEqual([
		"e6",
		"e1",
	]);
	expect(matchTopicEntities(all, ["こんにちは"])).toEqual([]);
	// At most five.
	const many = Array.from({ length: 8 }, (_, i) =>
		entity(`n${i}`, `対象${i}号`),
	);
	expect(
		matchTopicEntities(many, [many.map((e) => e.displayName).join(" ")]),
	).toHaveLength(5);
});

const register = (id: string, name: string, aliases: string[] = []) =>
	request(`entity-${id}`, {
		kind: "entity.register",
		entity: { id, displayName: name, aliases, externalRefs: [] },
	});

/** svc-1 (音声サービス) is available and depends on svc-2 (LARM); svc-5 (天気) is unrelated; two entities share "共通". */
async function seedWorld(h: Harness) {
	await h.world.apply(entityOp());
	for (const op of [
		register("svc-2", "LARM"),
		register("svc-3", "窓口A", ["共通"]),
		register("svc-4", "窓口B", ["共通"]),
		register("svc-5", "天気"),
	])
		expect((await h.world.apply(op)).status).toBe("applied");
	await addMessage(h, "m1", "音声サービスはLARMに依存している。天気は晴れ。");
	const ref = currentRef(h, "m1");
	const claims = [
		claim("c-state", [ref]),
		claim("c-dep", [ref], {
			predicate: "depends",
			payload: { kind: "relation", relation: "depends_on", objectId: "svc-2" },
		}),
		claim("c-weather", [ref], { subjectId: "svc-5" }),
		claim("c-other", [ref], {
			subjectId: "svc-3",
			predicate: "available",
		}),
	];
	for (const [i, c] of claims.entries()) {
		expect((await h.world.apply(registerClaim(`reg-${i}`, c))).status).toBe(
			"applied",
		);
		expect(
			(
				await h.world.apply(
					request(`adopt-${i}`, {
						kind: "assertion.transition",
						plan: adoptPlan(c.id, 1),
					}),
				)
			).status,
		).toBe("applied");
	}
}

const names = (h: Harness, texts: string[]) =>
	h.store.write((db) =>
		createWorldContextNames({
			world: h.world,
			purpose: PURPOSE,
		}).knownNamesInTransaction(db, { conversationId: "c1", texts }),
	);

test("a named target gives its display name only, by name or alias, the current wording first", async () => {
	await withHarness(async (h) => {
		await seedWorld(h);
		expect(await names(h, ["音声サービスは大丈夫？", "前の話"])).toEqual([
			"音声サービス",
		]);
		// The target named only by an alias works too, and the previous exchange counts.
		expect(await names(h, ["どう？", "音声が止まった"])).toEqual([
			"音声サービス",
		]);
		expect(await names(h, ["天気とLARMの話", "音声サービス"])).toEqual([
			"LARM",
			"天気",
			"音声サービス",
		]);
		// Nothing but names: no claim text and no id comes with them.
		const text = JSON.stringify(await names(h, ["音声サービスは大丈夫？"]));
		expect(text).not.toContain("svc-1");
		expect(text).not.toContain("c-state");
	});
});

test("no known target named, only an ambiguous alias, or no wording: nothing", async () => {
	await withHarness(async (h) => {
		await seedWorld(h);
		for (const texts of [["こんにちは"], ["共通の件"], [], [" "]])
			expect(await names(h, texts)).toEqual([]);
	});
});

test("World not usable: nothing, even when the wording names a target", async () => {
	await withHarness(async (h) => {
		await seedWorld(h);
		await h.world.setEnabled(false);
		expect(await names(h, ["音声サービスは大丈夫？"])).toEqual([]);
	});
});
