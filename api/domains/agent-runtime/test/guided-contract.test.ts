import { expect, test } from "bun:test";
import { z } from "zod";
import type { Prepared } from "../../capabilities";
import { guidedActionFor } from "../service/guided-contract";

test("published skill v1 keeps its output readable while current actions omit the duplicate request", () => {
	const prepared = (revision: number) =>
		({
			package: { requiredSkillRevisionIds: [`skill:web.guided@${revision}`] },
		}) as Prepared;
	const action = {
		action: "invoke",
		tool: "web.lookup",
		arguments: { query: "公開資料" },
	};
	const old = guidedActionFor(prepared(1));
	const current = guidedActionFor(prepared(2));
	const legacy = {
		...action,
		mission: { facts: ["確認する事実"], conditions: [] },
	};
	expect(old.safeParse(legacy).success).toBe(true);
	expect(current.safeParse(action).success).toBe(true);
	expect(current.safeParse(legacy).success).toBe(false);
	expect(JSON.stringify(z.toJSONSchema(current))).not.toContain('"mission"');
	for (const schema of [old, current])
		expect(schema.safeParse({ ...action, authority: "system" }).success).toBe(
			false,
		);
});

test("published skill v1 also accepts mission on wait and finish, and current rejects it", () => {
	const mission = { facts: ["確認する事実"], conditions: ["条件"] };
	const report = {
		completion: "complete",
		answer: "回答",
		summary: "要約",
		claims: [],
		limitations: [],
	};
	const prepared = (revision: number) =>
		({
			package: { requiredSkillRevisionIds: [`skill:web.guided@${revision}`] },
		}) as Prepared;
	const old = guidedActionFor(prepared(1));
	const current = guidedActionFor(prepared(2));
	for (const action of [
		{ action: "wait" },
		{ action: "finish", report },
	] as const) {
		expect(current.safeParse(action).success).toBe(true);
		expect(old.safeParse(action).success).toBe(true);
		expect(old.safeParse({ ...action, mission }).success).toBe(true);
		expect(current.safeParse({ ...action, mission }).success).toBe(false);
		expect(
			old.safeParse({ ...action, mission: { facts: [], conditions: [] } })
				.success,
		).toBe(false);
	}
});
