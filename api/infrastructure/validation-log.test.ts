import { expect, test } from "bun:test";
import { z } from "zod";
import { repairIssues, validationIssues } from "./validation-log";

test("validation diagnostics expose paths, types and bounds, but never values, unknown keys or Zod messages", () => {
	const schema = z
		.object({ report: z.object({ summary: z.string().max(4) }).strict() })
		.strict();
	const value = {
		report: { summary: "SECRET_PROVIDER_TEXT", SECRET_KEY: "SECRET_VALUE" },
	};
	const parsed = schema.safeParse(value);
	if (parsed.success) throw new Error("fixture_must_fail");
	const diagnostics = validationIssues(parsed.error, value);
	expect(diagnostics[0]).toMatchObject({
		validationPath: "report.summary",
		validationCode: "too_big",
		actualType: "string",
		limit: 4,
	});
	expect(diagnostics[1]).toMatchObject({
		validationPath: "report",
		validationCode: "unrecognized_keys",
	});
	expect(JSON.stringify(diagnostics)).not.toContain("SECRET");
	const malicious = z
		.record(z.string(), z.number())
		.safeParse({ SECRET_KEY: "SECRET_VALUE" });
	if (malicious.success) throw new Error("fixture_must_fail");
	expect(
		validationIssues(malicious.error, { SECRET_KEY: "SECRET_VALUE" })[0],
	).toEqual({
		validationPath: "unknown",
		validationCode: "invalid_type",
		expectedType: "number",
		actualType: "string",
	});
});

test("many invalid entries keep the first eight field locations, including array indices", () => {
	const value = { claims: Array.from({ length: 30 }, () => ({ text: null })) };
	const parsed = z
		.object({ claims: z.array(z.object({ text: z.string() })) })
		.safeParse(value);
	if (parsed.success) throw new Error("fixture_must_fail");
	expect(parsed.error.issues).toHaveLength(30);
	const issues = validationIssues(parsed.error, value, ["report"]);
	expect(issues).toHaveLength(8);
	expect(issues[7]).toMatchObject({
		validationPath: "report.claims.7.text",
		expectedType: "string",
		actualType: "null",
	});
});

test("a conversation tool's call names its tool and field in the log, and tells the model a missing field is required", () => {
	const schema = z
		.object({ mode: z.literal("execute"), impact: z.enum(["none", "create"]) })
		.strict();
	const value = { mode: "execute" };
	const parsed = schema.safeParse(value);
	if (parsed.success) throw new Error("fixture_must_fail");
	expect(validationIssues(parsed.error, value, ["delegate"])[0]).toMatchObject({
		validationPath: "delegate.impact",
		actualType: "undefined",
	});
	expect(repairIssues(parsed.error, value)[0]).toEqual({
		path: "impact",
		code: "required",
		allowed: ["none", "create"],
	});
	// A value that is there but wrong keeps its own code.
	const wrong = schema.safeParse({ mode: "execute", impact: "huge" });
	if (wrong.success) throw new Error("fixture_must_fail");
	expect(
		repairIssues(wrong.error, { mode: "execute", impact: "huge" })[0],
	).toMatchObject({ path: "impact", code: "invalid_value" });
});
