import { expect, test } from "bun:test";
import { evaluateSearchAnswer } from "./search-answer-evaluation";
import {
	weatherSample,
	stockSample,
	searchAnswerControls,
} from "./search-answer-evaluation.fixture";

const pass = {
	target: "pass",
	fieldValueUnit: "pass",
	validTime: "pass",
	evidence: "pass",
	requestSatisfied: "pass",
	unsupportedStatements: [],
	reasons: ["一致"],
};
test("acceptance fails closed on missing, invalid, unknown and incomplete evaluations", async () => {
	for (const output of [
		"invalid",
		"{}",
		JSON.stringify({ ...pass, validTime: "unknown" }),
		JSON.stringify({ ...pass, fieldValueUnit: "fail" }),
		JSON.stringify({ ...pass, unsupportedStatements: ["資料にない断定"] }),
	])
		expect(
			(await evaluateSearchAnswer(weatherSample, async () => output)).ok,
		).toBe(false);
	expect(
		(
			await evaluateSearchAnswer(weatherSample, async () => {
				throw new Error("offline");
			})
		).ok,
	).toBe(false);
	expect(
		(
			await evaluateSearchAnswer(weatherSample, async () =>
				JSON.stringify(pass),
			)
		).ok,
	).toBe(true);
});
test("evaluation reuses the provider's strict JSON contract without prompt-only schemas", async () => {
	await evaluateSearchAnswer(weatherSample, async (messages, options) => {
		expect(options.jsonOutput).toBe(true);
		expect(options.jsonSchema).toMatchObject({
			type: "object",
			additionalProperties: false,
		});
		expect(options.sessionRole).toBe("auxiliary");
		expect(options.contextPolicy).toBe("exact");
		expect(messages[0]!.content).not.toContain("OUTPUT_SCHEMA=");
		return JSON.stringify(pass);
	});
});
test("a judge cannot grant nonexistent evidence or a code-only citation", async () => {
	for (const sample of [
		{
			...weatherSample,
			report: {
				...weatherSample.report!,
				claims: [
					{
						...weatherSample.report!.claims[0]!,
						evidence: [{ sourceId: "s1", quote: "捏造した引用" }],
					},
				],
			},
		},
		searchAnswerControls.find((c) => c.id === "link-only-in-code")!.sample,
	])
		expect(
			(await evaluateSearchAnswer(sample, async () => JSON.stringify(pass))).ok,
		).toBe(false);
});
test("honest uncertainty and unsupported attribution are separate from complete acceptance", async () => {
	const result = await evaluateSearchAnswer(stockSample, async () =>
		JSON.stringify({ ...pass, requestSatisfied: "unknown" }),
	);
	expect(result.ok).toBe(false);
	expect(result.verdict!.unsupportedStatements).toEqual([]);
});
