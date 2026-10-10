import { test, expect } from "bun:test";
import { workerContext } from "../service/context";
import { evidenceObservation } from "../service/evidence-excerpts";
import { verifyReport } from "../service/verify-report";
import {
	bytes,
	createCapabilities,
	migration,
	type Prepared,
} from "../../capabilities";
import { openStore } from "../../../infrastructure/sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Source } from "../../tool-runtime";
import type { Task } from "../contracts";
async function builtinPrepared() {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-worker-context-"));
	const store = openStore(join(dir, "db"), [migration]);
	const caps = createCapabilities(store);
	try {
		await caps.seed();
		// These cases exercise the archived renderer; v6 saved views have separate tests.
		await store.write((db) =>
			db
				.query("UPDATE capability_items SET active_revision_id=? WHERE key=?")
				.run("package:web.research@6", "package:web.research"),
		);
		const owner = { taskId: "worker", rootRunId: "root", cancelEpoch: 0 };
		return await store.write((db) => {
			const candidates = caps.searchInTransaction(
				db,
				owner,
				"調査",
				["web.research"],
				Date.now() + 10000,
			);
			const ref = candidates.find((c) => c.id === "web.research")!.candidateRef;
			return caps.prepareInTransaction(db, owner, ref, {
				question: "東京の天気",
			});
		});
	} finally {
		caps.close();
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
}
test("read suggestions advance to an unread lookup candidate and require the granted read tool", async () => {
	const prepared = await builtinPrepared();
	const base: Source = {
		sourceId: "a",
		url: "https://example.com/a",
		title: "candidate",
		basis: "snippet",
		fetchedAt: "2026-10-10T00:00:00Z",
		truncated: false,
		body: "summary",
	};
	const sources = [
		base,
		{ ...base, sourceId: "b", url: "https://example.com/b" },
		{
			...base,
			sourceId: "page-a",
			basis: "page" as const,
			body: "navigation only",
		},
	];
	const task = {
		tool_calls: 2,
		model_calls: 2,
		json_repairs: 0,
		error_code: null,
	} as Task;
	const tools = [
		{
			executionRef: "opaque",
			tool: { id: "web.read", schemaKey: "read" as const },
		},
	];
	const context = workerContext(task, prepared, tools, sources, []);
	expect(JSON.parse(context.messages[1]!.content).nextInvocation).toEqual({
		action: "invoke",
		executionRef: "web.read",
		arguments: { url: "https://example.com/b" },
	});
	expect(
		JSON.parse(
			workerContext(task, prepared, [], sources, []).messages[1]!.content,
		).nextInvocation,
	).toBeNull();
});
test("only the selected profile and required skills become instructions; hints cannot introduce unbound tools", async () => {
	const base = await builtinPrepared();
	const selected = base.package;
	const definitions = base.dependencies;
	const extra = definitions
		.filter((d) => ["profile", "skill"].includes(d.kind))
		.map((d) => ({
			...d,
			revisionId: `${d.kind}:unused@1`,
			id: "unused",
			body: "UNSELECTED_ROLE_CHANGE",
		}));
	const prepared: Prepared = {
		package: selected,
		dependencies: [
			...definitions.filter((d) => d.kind !== "package"),
			...extra,
		],
		input: { question: "東京の天気" },
	};
	const task = {
		tool_calls: 0,
		model_calls: 0,
		json_repairs: 0,
		error_code: null,
	} as Task;
	const context = workerContext(task, prepared, [], [], [], {
		toolId: "web.quote",
		arguments: { symbol: "AAPL" },
	});
	expect(context.messages[0]!.content).toContain("公開情報の調査を担当");
	expect(context.messages[0]!.content).toContain("公開資料を調べて要約");
	// The selected research instructions remain generic even for a weather task.
	for (const topic of ["天気", "最高気温", "降水確率", "紫外線", "株価"])
		expect(context.messages[0]!.content).not.toContain(topic);
	expect(context.messages[0]!.content).toContain("質問への直接の答え");
	expect(context.messages[0]!.content).toContain("実際に取得した資料のURL");
	expect(context.messages[0]!.content).not.toContain("UNSELECTED_ROLE_CHANGE");
	expect(JSON.parse(context.messages[1]!.content).nextInvocation).toBeNull();
	const calendar = JSON.parse(context.messages[1]!.content);
	expect(Date.parse(calendar.nextDate) - Date.parse(calendar.currentDate)).toBe(
		86400000,
	);
	expect(() =>
		workerContext(
			task,
			{
				...prepared,
				dependencies: prepared.dependencies.filter(
					(d) => !selected.requiredSkillRevisionIds?.includes(d.revisionId),
				),
			},
			[],
			[],
			[],
		),
	).toThrow("required_context_missing");
});

test("escaped long requests retain mandatory instructions while optional observations fit the context budget", async () => {
	const base = await builtinPrepared();
	const selected = base.package;
	const definitions = base.dependencies;
	const question = "\\".repeat(8000);
	const profileBody = "MANDATORY_PROFILE " + "a".repeat(8000);
	const prepared: Prepared = {
		package: selected,
		dependencies: definitions
			.filter((d) => d.kind !== "package")
			.map((d) =>
				d.revisionId === selected.profileRevisionId
					? { ...d, body: profileBody }
					: d,
			),
		input: { question },
	};
	const sources: Source[] = Array.from({ length: 4 }, (_, i) => ({
		sourceId: `source-${i}`,
		url: `https://example.com/${i}`,
		title: "source",
		basis: "page",
		fetchedAt: "2026-10-09T00:00:00Z",
		truncated: false,
		body: "\\".repeat(4800),
	}));
	const task = {
		tool_calls: 0,
		model_calls: 0,
		json_repairs: 0,
		error_code: null,
	} as Task;
	const context = workerContext(task, prepared, [], sources, []);
	expect(bytes(context.messages)).toBeLessThanOrEqual(65536);
	expect(context.messages[0]!.content).toContain(profileBody);
	expect(context.messages[0]!.content).toContain("公開資料を調べて要約");
	const data = JSON.parse(context.messages[1]!.content);
	expect(data.task.question).toBe(question);
	expect(data.observations).toEqual(context.visible.map(evidenceObservation));
	expect(
		context.visible.reduce((sum, source) => sum + source.body.length, 0),
	).toBeLessThan(sources.reduce((sum, source) => sum + source.body.length, 0));
});

test("only displayed excerpts can be cited, including when page and context budgets remove text", async () => {
	const prepared = await builtinPrepared();
	const sources: Source[] = Array.from({ length: 4 }, (_, i) => ({
		sourceId: `source-${i}`,
		url: `https://example.com/${i}`,
		title: "source",
		basis: "page",
		fetchedAt: "2026-10-09T00:00:00Z",
		truncated: false,
		body: "資料の事実。".repeat(1000),
	}));
	const task = {
		tool_calls: 1,
		model_calls: 1,
		json_repairs: 0,
		error_code: null,
	} as Task;
	const context = workerContext(task, prepared, [], sources, []);
	const data = JSON.parse(context.messages[1]!.content);
	expect(bytes(data.observations)).toBeLessThanOrEqual(20000);
	expect(data.observations).toEqual(context.visible.map(evidenceObservation));
	for (const observation of data.observations) {
		for (const excerpt of observation.excerpts) {
			const report = verifyReport(
				{
					summary: "資料の事実",
					claims: [
						{
							text: "資料の事実",
							evidence: [
								{
									sourceId: observation.sourceId,
									excerptId: excerpt.excerptId,
								},
							],
						},
					],
					limitations: [],
				},
				context.visible,
				false,
			);
			expect(report.claims[0]!.evidence[0]!.quote).toBe(excerpt.quote);
		}
	}
	expect(context.visible.some((s) => s.truncated)).toBe(true);
	const hidden = context.visible[0]!;
	expect(() =>
		verifyReport(
			{
				summary: "資料の事実",
				claims: [
					{
						text: "資料の事実",
						evidence: [{ sourceId: hidden.sourceId, excerptId: "e99" }],
					},
				],
				limitations: [],
			},
			context.visible,
			false,
		),
	).toThrow("invalid_evidence");
});

test("a later large page cannot evict the already-read forecast or the other search candidates", async () => {
	const prepared = await builtinPrepared();
	const base: Source = {
		sourceId: "forecast",
		url: "https://example.com/forecast",
		title: "forecast",
		basis: "page",
		fetchedAt: "2026-10-09T00:00:00Z",
		truncated: false,
		body: "今日 10月10日 晴れ 最高26℃。\n" + "資料の補足。".repeat(1000),
	};
	const sources: Source[] = [
		...Array.from({ length: 5 }, (_, i) => ({
			...base,
			sourceId: `hit-${i}`,
			basis: "snippet" as const,
			body: "検索候補の説明。".repeat(50),
		})),
		base,
		{ ...base, sourceId: "second", body: "別ページの内容。".repeat(1000) },
		{ ...base, sourceId: "last", body: "ナビゲーション。".repeat(1000) },
	];
	const context = workerContext(
		{
			tool_calls: 4,
			model_calls: 4,
			json_repairs: 0,
			error_code: null,
		} as Task,
		prepared,
		[],
		sources,
		[],
	);
	const data = JSON.parse(context.messages[1]!.content);
	expect(bytes(data.observations)).toBeLessThanOrEqual(20000);
	expect(context.visible.map((s) => s.sourceId)).toEqual(
		sources.map((s) => s.sourceId),
	);
	const forecast = context.visible.find((s) => s.sourceId === "forecast")!;
	expect(forecast.body).toContain("今日 10月10日 晴れ 最高26℃。");
	expect(forecast.truncated).toBe(true);
	const report = verifyReport(
		{
			summary: "晴れで26℃",
			claims: [
				{
					text: "最高26℃",
					evidence: [{ sourceId: "forecast", excerptId: "e0" }],
				},
			],
			limitations: [],
		},
		context.visible,
		false,
	);
	expect(report.claims[0]!.evidence[0]!.quote).toContain("最高26℃");
});

test("additional search snippets yield budget to the date-specific page evidence; exhausted tools require finish", async () => {
	const prepared = await builtinPrepared();
	const base: Source = {
		sourceId: "forecast",
		url: "https://example.com/forecast",
		title: "forecast",
		basis: "page",
		fetchedAt: "2026-10-09T00:00:00Z",
		truncated: false,
		body:
			"今日の資料。".repeat(140) +
			"\n明日 10月11日 晴れ 最高26℃。\n" +
			"資料の補足。".repeat(1000),
	};
	const sources: Source[] = [
		...Array.from({ length: 10 }, (_, i) => ({
			...base,
			sourceId: `hit-${i}`,
			basis: "snippet" as const,
			body: "検索候補の説明。".repeat(60),
		})),
		base,
		{ ...base, sourceId: "second", body: "別ページの内容。".repeat(1000) },
		{ ...base, sourceId: "last", body: "ナビゲーション。".repeat(1000) },
	];
	const context = workerContext(
		{
			tool_calls: 5,
			model_calls: 6,
			json_repairs: 0,
			error_code: null,
		} as Task,
		prepared,
		[],
		sources,
		[],
	);
	const data = JSON.parse(context.messages[1]!.content);
	expect(bytes(data.observations)).toBeLessThanOrEqual(20000);
	expect(
		context.visible.find((s) => s.sourceId === "forecast")!.body,
	).toContain("明日 10月11日 晴れ 最高26℃。");
	expect(context.messages[0]!.content).toContain("invokeは使えません");
	const schema = JSON.parse(
		context.messages[0]!.content.split("OUTPUT_SCHEMA=")[1]!,
	);
	expect(schema.properties.action.const).toBe("finish");
	for (const source of context.visible.filter((s) => s.basis === "snippet"))
		expect(source.body.length).toBeLessThanOrEqual(160);
});
