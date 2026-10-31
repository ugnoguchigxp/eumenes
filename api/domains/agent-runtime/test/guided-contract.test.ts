import { expect, test } from "bun:test";
import { z } from "zod";
import type { Prepared } from "../../capabilities";
import { guidedActionFor } from "../service/guided-contract";

test("current actions omit the duplicate request", () => {
	const current = guidedActionFor({
		package: { requiredSkillRevisionIds: ["skill:web.guided@5"] },
	} as Prepared);
	const action = {
		action: "invoke",
		tool: "web.lookup",
		arguments: { query: "公開資料" },
	};
	const mission = { facts: ["確認する事実"], conditions: [] };
	expect(current.safeParse(action).success).toBe(true);
	expect(current.safeParse({ ...action, mission }).success).toBe(false);
	expect(current.safeParse({ action: "wait", mission }).success).toBe(false);
	expect(JSON.stringify(z.toJSONSchema(current))).not.toContain('"mission"');
	expect(current.safeParse({ ...action, authority: "system" }).success).toBe(
		false,
	);
});

test("readAhead accepts an array of URL strings and rejects the former object form", () => {
	const current = guidedActionFor({
		package: { requiredSkillRevisionIds: ["skill:web.guided@4"] },
	} as Prepared);
	const invoke = {
		action: "invoke",
		tool: "web.read",
		arguments: { url: "https://example.com/a" },
	};
	const urls = ["https://example.com/b", "https://example.com/c"];
	expect(current.safeParse({ ...invoke, readAhead: urls }).success).toBe(true);
	expect(current.safeParse({ ...invoke, readAhead: [] }).success).toBe(true);
	expect(
		current.safeParse({ ...invoke, readAhead: urls.map((url) => ({ url })) })
			.success,
	).toBe(false);
	expect(
		current.safeParse({ ...invoke, readAhead: ["not a url"] }).success,
	).toBe(false);
	expect(
		current.safeParse({
			...invoke,
			readAhead: Array.from(
				{ length: 6 },
				(_, n) => `https://example.com/${n}`,
			),
		}).success,
	).toBe(false);
});
