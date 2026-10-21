import { expect, test } from "bun:test";
import { CandidateCatalog } from "../service/candidate-catalog";
import { candidateReport, guidedActionFor } from "../service/guided-contract";
import type { Prepared } from "../../capabilities";
import { EvidenceCatalog } from "../service/evidence-catalog";
import type { Source } from "../../tool-runtime";
import { validationIssues } from "../../../infrastructure/validation-log";
import { z } from "zod";
import { controlInstructions } from "../../inference";
const source = (n: number): Source => ({
	sourceId: `s${n}`,
	url: `https://example.org/${n}`,
	title: `候補${n}`,
	basis: "snippet",
	body: "未確認",
	fetchedAt: new Date(0).toISOString(),
	truncated: true,
});
test("the service route's candidate-only example satisfies its own contract without body evidence", () => {
	const action = guidedActionFor({
		package: { schemaKey: "guidedCandidates" },
	} as Prepared);
	const schema = z.toJSONSchema(action);
	const rendered = controlInstructions({
		instructions: "",
		outputSchema: schema,
	});
	const delivered = JSON.parse(rendered.slice(rendered.indexOf("=") + 1));
	expect(delivered).toEqual(schema);
	expect(
		action.safeParse({
			action: "invoke",
			tool: "browser.research",
			arguments: { request: "検索" },
		}).success,
	).toBe(true);
	const examples = z.toJSONSchema(candidateReport).examples as unknown[];
	expect(examples.length).toBeGreaterThan(0);
	for (const example of examples)
		expect(
			action.safeParse({ action: "finish", report: example }).success,
		).toBe(true);
	expect(examples).toContainEqual(
		expect.objectContaining({
			resultKind: "candidates",
			claims: [],
		}),
	);
});
test("only displayed live candidates may be returned or resolved into reads", () => {
	const c = new CandidateCatalog();
	expect(
		c.observe(Array.from({ length: 6 }, (_, i) => source(i))),
	).toHaveLength(5);
	expect(() => c.results(["c6"])).toThrow("candidate_invalidated");
	expect(c.results(["c1"])[0]).toMatchObject({
		url: "https://example.org/0",
		contentStatus: "unverified",
	});
	expect(() => c.results(["c1", "c1"])).toThrow("duplicate_candidate");
	const copy = c.copy();
	c.observe([]);
	expect(() => c.source("c1")).toThrow("candidate_invalidated");
	expect(copy.source("c1").url).toBe("https://example.org/0");
	const catalog = new EvidenceCatalog();
	catalog.candidates.observe([source(1)]);
	expect(catalog.arguments({ candidateRef: "c1" })).toEqual({
		url: "https://example.org/1",
	});
	expect(() =>
		catalog.arguments({ candidateRef: "c1", url: "https://other.example/" }),
	).toThrow();
});
test("candidate references never stand in for body facts", () => {
	const raw = {
		completion: "complete",
		answer: "候補を見つけました",
		summary: "候補",
		resultKind: "candidates",
		candidateRefs: ["c1"],
		claims: [],
		limitations: ["本文未確認"],
	};
	expect(candidateReport.safeParse(raw).success).toBe(true);
	expect(candidateReport.safeParse({ ...raw, recipe: null }).success).toBe(
		false,
	);
	expect(
		candidateReport.safeParse({
			...raw,
			claims: [{ text: "断定", status: "verified", evidence: ["c1"] }],
		}).success,
	).toBe(false);
	expect(
		candidateReport.safeParse({ ...raw, resultKind: "facts" }).success,
	).toBe(false);
	const mixed = candidateReport.safeParse({ ...raw, resultKind: "mixed" });
	if (mixed.success) throw new Error("body_evidence_required");
	expect(validationIssues(mixed.error, raw)[0]?.validationPath).toBe(
		"candidateRefs",
	);
	const schema = z.toJSONSchema(candidateReport);
	expect(schema.properties?.resultKind).toMatchObject({
		description: expect.stringContaining("本文根拠eN"),
	});
	expect(
		candidateReport.safeParse({
			...raw,
			resultKind: "mixed",
			claims: [
				{ text: "本文確認済みの事実", status: "verified", evidence: ["e1"] },
			],
		}).success,
	).toBe(true);
});
