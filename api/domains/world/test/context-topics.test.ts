/**
 * Topic targets (world-steward plan 4.1 (2)): the known targets a turn names are found by a deterministic
 * name/alias match, and the Slice is built from them (state + direct causal/dependency relations). Fixture-grade
 * on a REAL host store, like the Broker tests.
 */
import { expect, test } from "bun:test";
import { createWorldContextBroker, type ContextPrepareInput } from "..";
import { TOPIC_BLOCK_MAX_BYTES } from "../service/context-render";
import { matchTopicEntities } from "../service/context-topics";
import {
	NOW,
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

const prepareInput = (
	runId: string,
	over: Partial<ContextPrepareInput> = {},
): ContextPrepareInput => ({
	runId,
	conversationId: "c1",
	jobId: `job-${runId}`,
	attempt: 1,
	generation: 0,
	reservedBytes: 0,
	nowMs: NOW,
	...over,
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

const broker = (h: Harness) =>
	createWorldContextBroker({
		store: h.store,
		world: h.world,
		clock: () => NOW,
		purpose: PURPOSE,
	});

async function prepare(h: Harness, runId: string, topicTexts?: string[]) {
	const out = await h.store.write((db) =>
		broker(h).prepareInTransaction(
			db,
			prepareInput(runId, topicTexts ? { topicTexts } : {}),
		),
	);
	if (out.status !== "ready") throw new Error(JSON.stringify(out));
	return out;
}

test("a named target builds the Slice from its state and direct relations only, with names, within the topic block", async () => {
	await withHarness(async (h) => {
		await seedWorld(h);
		const out = await prepare(h, "r1", ["音声サービスは大丈夫？", "前の話"]);
		expect(out.context.topicEntityIds).toEqual(["svc-1"]);
		expect(out.context.slice.units.map((u) => u.assertionId).sort()).toEqual([
			"c-dep",
			"c-state",
		]);
		// Names make the ids readable; unrelated targets and their claims are absent.
		expect(out.block).toContain('"entities"');
		expect(out.block).toContain("LARM");
		expect(out.block).toContain("音声サービス");
		expect(out.block).not.toContain("c-weather");
		expect(out.context.budget.blockBytes).toBeLessThanOrEqual(
			TOPIC_BLOCK_MAX_BYTES,
		);
		// The target named only by an alias works too, and the previous exchange counts.
		const byAlias = await prepare(h, "r2", ["どう？", "音声が止まった"]);
		expect(byAlias.context.topicEntityIds).toEqual(["svc-1"]);
	});
});

test("no known target named, or only an ambiguous alias: today's default Slice", async () => {
	await withHarness(async (h) => {
		await seedWorld(h);
		const plain = await prepare(h, "r0");
		for (const [i, texts] of [["こんにちは"], ["共通の件"], []].entries()) {
			const out = await prepare(h, `r-${i}`, texts);
			expect(out.context.topicEntityIds).toEqual([]);
			expect(out.context.slice.units.map((u) => u.assertionId)).toEqual(
				plain.context.slice.units.map((u) => u.assertionId),
			);
			expect(out.block).not.toContain('"entities"');
		}
		// The default Slice carries the unrelated claims too.
		expect(
			plain.context.slice.units.some((u) => u.assertionId === "c-weather"),
		).toBe(true);
	});
});

test("a named target with nothing to say falls back to the default Slice", async () => {
	await withHarness(async (h) => {
		await seedWorld(h);
		const out = await prepare(h, "r1", ["LARMの話"]);
		// LARM is the object of svc-1's dependency: the claim acts on it, so it is shown.
		expect(out.context.topicEntityIds).toEqual(["svc-2"]);
		expect(out.context.slice.units.map((u) => u.assertionId)).toEqual([
			"c-dep",
		]);
		const quiet = await prepare(h, "r2", ["窓口Bの話"]);
		expect(quiet.context.topicEntityIds).toEqual([]);
	});
});
