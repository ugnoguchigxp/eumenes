import { test, expect } from "bun:test";
import { EvidenceCatalog } from "../service/evidence-catalog";
import { workerContext } from "../service/context";
import { workerDeadline, explorationBudget } from "../service/exploration";
import { verifyReport } from "../service/verify-report";
import type { Prepared } from "../../capabilities";
import type { Source } from "../../tool-runtime";
import type { Task } from "../contracts";
const prepared = {
	package: {
		backend: "web",
		profileRevisionId: "profile:p@1",
		requiredSkillRevisionIds: ["skill:s@1"],
	},
	dependencies: [
		{ revisionId: "profile:p@1", hash: "p", body: "old profile" },
		{ revisionId: "skill:s@1", hash: "s", body: "old planner" },
	],
	input: { question: "依頼" },
} as Prepared;
const task = { deadline: 180000, model_calls: 1, input_json: "{}" } as Task;
const source = (body: string): Source => ({
	sourceId: "same-document",
	sourceRef: "stored-body",
	viewId: crypto.randomUUID(),
	body,
	title: "資料",
	basis: "page",
	url: "https://example.com/",
	fetchedAt: "2026-10-10T00:00:00Z",
	truncated: false,
});
test("three distant ranges of one document keep immutable task evidence and use one document alias", () => {
	const catalog = new EvidenceCatalog();
	const first = catalog.observe([source("第一条件は10時。")]) as any[];
	const second = catalog.observe([source("第二条件は雨天中止。")]) as any[];
	const third = catalog.observe([source("第三条件は参加費500円。")]) as any[];
	expect([first[0].document, second[0].document, third[0].document]).toEqual([
		"d1",
		"d1",
		"d1",
	]);
	const report = catalog.report(
		{
			outcome: "answered",
			summary: "三条件",
			claims: [{ text: "三条件", evidence: ["e1", "e2", "e3"] }],
			limitations: [],
		},
		["3範囲"],
	);
	const checked = verifyReport(report, catalog.sources(), false, true);
	expect(checked.claims[0]!.evidence.map((e) => e.quote)).toEqual([
		"第一条件は10時。",
		"第二条件は雨天中止。",
		"第三条件は参加費500円。",
	]);
	expect(() =>
		catalog.report(
			{ ...report, claims: [{ text: "捏造", evidence: ["e999"] }] },
			[],
		),
	).toThrow("invalid_evidence");
});
test("evidence capacity stops additions without evicting previous references", () => {
	const catalog = new EvidenceCatalog();
	for (let i = 0; i < 90; i++) catalog.observe([source(`証拠${i}`)]);
	expect(catalog.list()).toHaveLength(64);
	expect(catalog.full).toBe(true);
	expect(JSON.stringify(catalog.list())).toContain("証拠0");
	expect(Buffer.byteLength(JSON.stringify(catalog.list()))).toBeLessThanOrEqual(
		8192,
	);
});
test("fixed contract retains the whole request, removes needs and suggestions, and scopes operation references", () => {
	const p = {
		...prepared,
		input: {
			question: Array.from(
				{ length: 10 },
				(_, i) => `第${i + 1}条件を必ず確認する。`,
			).join(""),
		},
	};
	const context = workerContext(
		task,
		p,
		[
			{
				executionRef: "internal-uuid",
				tool: { id: "web.find", schemaKey: "find" },
			},
		],
		[source("根拠")],
		[],
		null,
		new EvidenceCatalog(),
		0,
	);
	const packet = JSON.parse(context.messages[1]!.content);
	expect(packet.task.question).toBe(p.input.question);
	expect(packet.task.question).toContain("第7条件");
	expect(packet.needs).toBeUndefined();
	expect(packet.nextInvocation).toBeUndefined();
	expect(context.messages[0]!.content).not.toContain("internal-uuid");
	expect(context.messages[0]!.content).not.toContain("old planner");
	expect(JSON.stringify(packet)).not.toContain("stored-body");
	expect(context.grants).toEqual([
		{ id: "web.find", executionRef: "internal-uuid" },
	]);
});
test("all worker routes have one deadline policy; next-step exploration stops at the reservation boundary", () => {
	expect(workerDeadline(prepared, 180000, 0)).toBe(150000);
	expect(
		workerDeadline(
			{ ...prepared, package: { ...prepared.package, backend: "history" } },
			180000,
			0,
		),
	).toBe(150000);
	expect(
		explorationBudget({ ...task, deadline: 70000 }, prepared, [], 0).canOperate,
	).toBe(true);
	expect(
		explorationBudget({ ...task, deadline: 45000 }, prepared, [], 0).canOperate,
	).toBe(false);
});
test("bounded observations never register an excerpt absent from the actual model packet", () => {
	const catalog = new EvidenceCatalog();
	const context = workerContext(
		task,
		prepared,
		[],
		Array.from({ length: 30 }, () => source("日本語の資料".repeat(800))),
		[],
		null,
		catalog,
		0,
	);
	const data = JSON.parse(context.messages[1]!.content);
	const shown = new Set(
		data.observations.flatMap((o: any) =>
			o.excerpts.map((e: any) => e.reference),
		),
	);
	for (const ref of catalog.list()) expect(shown.has(ref.reference)).toBe(true);
	expect(
		Buffer.byteLength(
			JSON.stringify({
				evidence: data.evidence,
				observations: data.observations,
				operations: data.operations,
			}),
		),
	).toBeLessThanOrEqual(20000);
});
