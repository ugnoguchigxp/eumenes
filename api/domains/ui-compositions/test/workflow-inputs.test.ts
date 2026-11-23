import { expect, test } from "bun:test";
import { z } from "zod";
import { workflowScreenInputIssues } from "..";

const form = (type: string, required = true, options?: string[]) => ({
	view: "form",
	title: "入力",
	fields: [
		{
			id: "value",
			label: "値",
			type,
			required,
			...(options ? { options } : {}),
		},
	],
});
test("required inputs, fixed values and formal defaults cover workflow input", () => {
	const schema = z.object({ date: z.iso.date(), count: z.number().default(1) });
	expect(
		workflowScreenInputIssues(form("date"), { value: "date" }, schema, {}),
	).toEqual([]);
	expect(workflowScreenInputIssues(undefined, {}, schema, {})).toContainEqual(
		expect.objectContaining({ rule: "workflow_screen_input_missing" }),
	);
	expect(
		workflowScreenInputIssues(undefined, {}, schema, { date: "2026-11-23" }),
	).toEqual([]);
	expect(
		workflowScreenInputIssues(
			form("date", false),
			{ value: "date" },
			schema,
			{},
		),
	).toHaveLength(1);
});
test("form types, choices and fixed overrides are checked against the actual input", () => {
	expect(
		workflowScreenInputIssues(
			form("text"),
			{ value: "count" },
			z.object({ count: z.number() }),
			{},
		),
	).toContainEqual(
		expect.objectContaining({ rule: "workflow_screen_input_type" }),
	);
	expect(
		workflowScreenInputIssues(
			form("select", true, ["a", "b"]),
			{ value: "choice" },
			z.object({ choice: z.enum(["a"]) }),
			{},
		),
	).toHaveLength(1);
	expect(
		workflowScreenInputIssues(
			form("boolean"),
			{ value: "flag" },
			z.object({ flag: z.boolean() }),
			{},
		),
	).toEqual([]);
	expect(
		workflowScreenInputIssues(
			form("date"),
			{ value: "day" },
			z.object({ day: z.iso.date() }),
			{ day: "2026-11-23" },
		),
	).toHaveLength(1);
});

test("checkbox choices use the element type while runtime cardinality remains enforced", () => {
	const schema = z.object({
		tags: z
			.array(z.enum(["a", "b", "c"]))
			.min(2)
			.max(2),
	});
	const bindings = { value: "tags" };
	expect(
		workflowScreenInputIssues(
			form("checkbox", true, ["a", "b", "c"]),
			bindings,
			schema,
			{},
		),
	).toEqual([]);
	expect(schema.safeParse({ tags: ["a"] }).success).toBe(false);
	expect(schema.safeParse({ tags: ["a", "b"] }).success).toBe(true);
	expect(schema.safeParse({ tags: ["a", "b", "c"] }).success).toBe(false);
	expect(
		workflowScreenInputIssues(
			form("checkbox", true, ["a", "unknown"]),
			bindings,
			schema,
			{},
		),
	).toContainEqual(
		expect.objectContaining({ rule: "workflow_screen_input_type" }),
	);
});
