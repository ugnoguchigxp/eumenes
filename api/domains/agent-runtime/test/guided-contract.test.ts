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
