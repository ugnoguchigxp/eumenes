import { test, expect } from "bun:test";
import { z } from "zod";
import {
	researchAction,
	firstResearchAction,
	searchAction,
} from "../service/research-contract";
import { requirementVerification } from "../contracts/requirements";

const examplesOf = (schema: z.ZodType) =>
	(z.toJSONSchema(schema) as { examples?: unknown[] }).examples ?? [];

test("every research route carries minimal examples that pass its own schema", () => {
	for (const [schema, actions] of [
		[searchAction, ["invoke", "finish"]],
		[researchAction, ["invoke", "finish"]],
		[firstResearchAction, ["invoke", "finish"]],
	] as const) {
		const examples = examplesOf(schema);
		expect(
			examples.map((example) => (example as { action: string }).action),
		).toEqual([...actions]);
		for (const example of examples)
			expect(schema.safeParse(example).success).toBe(true);
	}
});

test("the first research step examples carry the frozen-contract inputs", () => {
	for (const example of examplesOf(firstResearchAction))
		expect(Object.keys(example as object)).toContain("requirements");
	for (const example of examplesOf(researchAction))
		expect(Object.keys(example as object)).not.toContain("requirements");
});

test("report schema states the conditions the host already enforces", () => {
	const json = JSON.stringify(z.toJSONSchema(researchAction));
	for (const phrase of [
		"answered/partialでは根拠付きのclaimを1件以上",
		"固定契約の全要件に一件ずつ",
		"なければ[]",
		"根拠参照（e1など）1〜3件",
	])
		expect(json).toContain(phrase);
});

test("every field of the requirement verification schema is described", () => {
	const walk = (node: any, path: string): string[] => {
		const missing: string[] = [];
		for (const [key, child] of Object.entries<any>(node.properties ?? {})) {
			if (!child.description) missing.push(`${path}.${key}`);
			if (child.items) missing.push(...walk(child.items, `${path}.${key}[]`));
		}
		return missing;
	};
	expect(walk(z.toJSONSchema(requirementVerification), "$")).toEqual([]);
});
