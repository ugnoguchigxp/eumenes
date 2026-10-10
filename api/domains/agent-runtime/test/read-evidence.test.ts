import { expect, test } from "bun:test";
import { verifyReport, parentProjection } from "../service/verify-report";
import { workerContext } from "../service/context";
import {
	explorationBudget,
	workerDeadline,
	stepDeadline,
} from "../service/exploration";
import type { Prepared } from "../../capabilities";
import type { Source } from "../../tool-runtime";
import type { Task } from "../contracts";
import { validateNeeds, canonicalNeeds } from "../service/validate-needs";
import { ValidationFailure } from "../../../infrastructure/validation-log";
import { coordinatorSchema } from "../service/coordinator-schema";
import { coordinatorContext } from "../service/context";
import { requestQuotes } from "../service/request-quotes";
import { correctedRead } from "../service/read-next";
import { requestUrls, selectedInput } from "../service/request-urls";
const source = (body: string): Source => ({
	sourceId: "same-source",
	viewId: crypto.randomUUID(),
	kind: "web_source",
	url: "https://example.com/fixture",
	title: "fixture",
	basis: "page",
	fetchedAt: "2026-10-10T00:00:00Z",
	body,
	truncated: false,
});
const raw = (s: Source) => ({
	version: 2,
	outcome: "answered",
	summary: "確認済み",
	claims: [
		{
			text: "事実",
			evidence: [{ sourceId: s.sourceId, viewId: s.viewId, excerptId: "e0" }],
		},
	],
	limitations: [],
	exploration: ["合成資料"],
});
function prepared(history = false): Prepared {
	return {
		package: {
			revisionId: history
				? "package:history.research@1"
				: "package:web.research@7",
			backend: history ? "history" : "web",
			profileRevisionId: "profile:fixture@1",
			requiredSkillRevisionIds: [
				history ? "skill:history.research@1" : "skill:web.research@6",
			],
		},
		dependencies: [
			{
				kind: "profile",
				revisionId: "profile:fixture@1",
				hash: "p",
				body: "担当指示",
			},
			{
				kind: "skill",
				revisionId: history
					? "skill:history.research@1"
					: "skill:web.research@6",
				hash: "s",
				body: "必要項目と読み返し",
			},
		],
		input: { question: "元依頼".repeat(1000) },
	} as Prepared;
}
test("R7: equal e0 identifiers in different views never redirect an old quotation; unpresented and forged views fail", () => {
	const old = source("旧版の値は10。"),
		current = { ...source("別範囲の値は20。"), sourceId: old.sourceId };
	expect(() => verifyReport(raw(old), [current], false, true)).toThrow(
		"invalid_evidence",
	);
	expect(() =>
		verifyReport(
			raw({ ...current, viewId: crypto.randomUUID() }),
			[old, current],
			false,
			true,
		),
	).toThrow("invalid_evidence");
	expect(
		verifyReport(raw(current), [old, current], false, true).claims[0]!
			.evidence[0]!.quote,
	).toBe("別範囲の値は20。");
	expect(() =>
		verifyReport(
			{
				summary: "旧形式",
				claims: [
					{
						text: "旧版",
						evidence: [{ sourceId: old.sourceId, quote: old.body }],
					},
				],
				limitations: [],
			},
			[old],
			false,
			true,
		),
	).toThrow("invalid_report");
});
test("zero evidence has bounded not_found/clarification/failed outcomes; answered/partial still require evidence", () => {
	for (const outcome of [
		"not_found",
		"clarification_required",
		"failed",
	] as const) {
		const report = verifyReport(
			{
				version: 2,
				outcome,
				summary: "確認範囲で根拠がありません",
				claims: [],
				limitations: ["未走査の範囲があります"],
				exploration: ["許可された会話の500件"],
			},
			[],
			false,
			true,
		);
		expect(report.sources).toEqual([]);
		expect(parentProjection(report).outcome).toBe(outcome);
	}
	for (const outcome of ["answered", "partial"])
		expect(() =>
			verifyReport(
				{
					version: 2,
					outcome,
					summary: "無根拠",
					claims: [],
					limitations: [],
					exploration: ["合成資料"],
				},
				[],
				false,
				true,
			),
		).toThrow("invalid_report");
});
test("combined optional observations and operation notes remain <=20000 bytes while the original request survives", () => {
	const p = prepared(),
		sources = Array.from({ length: 40 }, (_, i) => ({
			...source("資料".repeat(1000)),
			sourceId: String(i),
		}));
	const task = { tool_calls: 9, model_calls: 10, error_code: null } as Task;
	const operations = Array.from({ length: 9 }, (_, i) => ({
		tool: i < 5 ? "tool:web.read@1" : "tool:web.find@1",
		state: "succeeded",
		notes: { text: "任意情報".repeat(1000) },
	}));
	const context = workerContext(task, p, [], sources, operations),
		data = JSON.parse(context.messages[1]!.content);
	expect(data.task.question).toBe((p.input as { question: string }).question);
	expect(
		Buffer.byteLength(
			JSON.stringify({
				observations: data.observations,
				operations: data.operations,
			}),
		),
	).toBeLessThanOrEqual(20000);
	expect(context.visible.map((s) => s.viewId)).toEqual(
		data.observations.map((s: Source) => s.viewId),
	);
	expect(data.budget.localCallsUsed).toBe(4);
	expect(data.budget.externalCallsUsed).toBe(5);
});
test("host reserves a final model call and time for both workers, without renewing operation budgets", () => {
	const t = { model_calls: 11, deadline: 20000 } as Task;
	expect(explorationBudget(t, prepared(), [], 1000).canOperate).toBe(false);
	expect(
		explorationBudget({ ...t, model_calls: 6 }, prepared(true), [], 1000)
			.canOperate,
	).toBe(false);
	expect(
		explorationBudget(
			{ ...t, model_calls: 1, deadline: 6000 },
			prepared(),
			[],
			1000,
		).canOperate,
	).toBe(false);
	expect(
		explorationBudget(
			{ ...t, model_calls: 1, deadline: 16000 },
			prepared(),
			[],
			1000,
		).canOperate,
	).toBe(false);
	const budget = explorationBudget(
		{ ...t, model_calls: 10 },
		prepared(),
		Array.from({ length: 9 }, (_, i) => ({
			toolRevisionId:
				i < 2
					? "tool:web.lookup@1"
					: i < 5
						? "tool:web.read@1"
						: "tool:web.find@1",
			state: "failed",
		})),
		1000,
	);
	expect([
		budget.localCalls,
		budget.externalCalls,
		budget.reads,
		budget.searches,
	]).toEqual([4, 5, 3, 2]);
});
test("the first read schema requires needs and supplies a verbatim request quote; later steps retain the needs state", () => {
	const p = prepared();
	p.input = {
		question: "https://example.com/fixture の資料を確認して",
		urls: ["https://example.com/fixture"],
	};
	const task = { model_calls: 0, tool_calls: 0 } as Task;
	for (const first of [true, false]) {
		const context = workerContext(
			{ ...task, exploration_json: first ? null : "[]" },
			p,
			[{ executionRef: "grant", tool: { id: "web.read", schemaKey: "read" } }],
			[],
			[],
		);
		const system = context.messages[0]!.content;
		const schema = JSON.parse(system.split("OUTPUT_SCHEMA=")[1]!);
		for (const branch of schema.oneOf ?? schema.anyOf)
			expect(branch.required.includes("needs")).toBe(first);
		const data = JSON.parse(context.messages[1]!.content);
		expect(data.initialNeedsRequired).toBe(first);
		expect((p.input as { question: string }).question).toContain(
			data.requestQuoteExample,
		);
	}
});
test("without request or observed URLs only search is presented; observed candidates enable read without changing the fixed grant digest", () => {
	const tools = [
		{
			executionRef: "lookup-grant",
			tool: { id: "web.lookup", schemaKey: "lookup" as const },
		},
		{
			executionRef: "read-grant",
			tool: { id: "web.read", schemaKey: "read" as const },
		},
	];
	const initial = workerContext({} as Task, prepared(), tools, [], []),
		after = workerContext(
			{} as Task,
			prepared(),
			tools,
			[{ ...source("検索結果"), basis: "snippet" }],
			[],
		);
	const ids = (context: typeof initial) =>
		JSON.parse(
			context.messages[0]!.content.split("TOOLS=")[1]!.split(
				"\nOUTPUT_SCHEMA=",
			)[0]!,
		).map((t: { id: string }) => t.id);
	expect(ids(initial)).toEqual(["web.lookup"]);
	expect(ids(after)).toEqual(["web.lookup", "web.read"]);
	expect(after.manifestDigest).toBe(initial.manifestDigest);
});
test("read invocation schemas enumerate only the original request URLs and already observed candidate URLs", () => {
	const p = prepared(),
		url = "https://example.com/original";
	p.input = { question: `${url} を調べて`, urls: [url] };
	const context = workerContext(
		{} as Task,
		p,
		[{ executionRef: "grant", tool: { id: "web.read", schemaKey: "read" } }],
		[source("資料")],
		[],
	);
	const output = JSON.parse(
		context.messages[0]!.content.split("OUTPUT_SCHEMA=")[1]!,
	);
	const invocation = (output.oneOf ?? output.anyOf).find(
		(b: { properties: { executionRef?: { const?: string } } }) =>
			b.properties.executionRef?.const === "web.read",
	);
	expect(invocation.properties.arguments.properties.url.enum).toEqual([
		url,
		"https://example.com/fixture",
	]);
});
test("finish-only steps still scope evidence to visible views and give an executable failure shape without fabricating claims", () => {
	const s = source("観測した資料");
	const context = workerContext(
		{ model_calls: 5, tool_calls: 4, exploration_json: null } as Task,
		prepared(),
		[],
		[s],
		[],
	);
	const data = JSON.parse(context.messages[1]!.content);
	expect(data.budget.canInvoke).toBe(false);
	expect(data.finishExample.action).toBe("finish");
	expect(
		verifyReport(data.finishExample.report, context.visible, true, true)
			.outcome,
	).toBe("failed");
	expect(data.finishExample.report.claims).toEqual([]);
	validateNeeds(
		data.finishExample.needs,
		(prepared().input as { question: string }).question,
		true,
	);
	const output = JSON.parse(
		context.messages[0]!.content.split("OUTPUT_SCHEMA=")[1]!,
	);
	expect(output.properties.action.const).toBe("finish");
	const choices =
		output.properties.report.properties.claims.items.properties.evidence.items
			.oneOf;
	expect(choices[0].properties.sourceId.const).toBe(s.sourceId);
	expect(choices[0].properties.viewId.const).toBe(s.viewId);
});
test("body read references identify the visible document separately from its citation identifiers and deduplicate head/tail views", () => {
	const a = { ...source("冒頭"), sourceRef: crypto.randomUUID() },
		b = {
			...source("別資料"),
			sourceRef: crypto.randomUUID(),
			url: "https://example.com/another",
		};
	const context = workerContext(
		{} as Task,
		prepared(),
		[],
		[
			a,
			{ ...a, viewId: crypto.randomUUID(), body: "末尾" },
			b,
			source("検索snippet"),
		],
		[],
	);
	const refs = JSON.parse(context.messages[1]!.content).bodyReadReferences;
	expect(refs).toEqual(
		[a, b].map((s) => ({ sourceRef: s.sourceRef, title: s.title, url: s.url })),
	);
	expect(
		refs.every(
			(r: { sourceId?: string; viewId?: string }) => !r.sourceId && !r.viewId,
		),
	).toBe(true);
});
test("saved range guidance uses a match cursor, omits start, and never repeats a successful cursor", () => {
	const sourceRef = crypto.randomUUID(),
		cursor = crypto.randomUUID(),
		continuation = crypto.randomUUID();
	const tools = [
		{
			executionRef: "grant",
			tool: { id: "web.read_saved", schemaKey: "readSaved" as const },
		},
	];
	const operations = [
		{
			tool: "tool:web.find@1",
			state: "succeeded",
			notes: {
				sourceRef,
				matches: [{ cursor, start: 5000, end: 5010 }],
				cursor: continuation,
			},
		},
	];
	const context = workerContext(
		{} as Task,
		prepared(),
		tools,
		[{ ...source("先頭のプレビュー"), sourceRef, start: 0, end: 100 }],
		operations,
	);
	const data = JSON.parse(context.messages[1]!.content);
	expect(data.nextInvocation).toEqual({
		action: "invoke",
		executionRef: "web.read_saved",
		arguments: { sourceRef, cursor, characters: 2400 },
	});
	const contract = JSON.parse(
		context.messages[0]!.content.split("TOOLS=")[1]!.split(
			"\nOUTPUT_SCHEMA=",
		)[0]!,
	)[0];
	expect(contract.inputSchema.not).toEqual({ required: ["cursor", "start"] });
	const output = JSON.parse(
		context.messages[0]!.content.split("OUTPUT_SCHEMA=")[1]!,
	);
	const invocation = (output.oneOf ?? output.anyOf).find(
		(b: { properties: { executionRef?: { const?: string } } }) =>
			b.properties.executionRef?.const === "web.read_saved",
	);
	const [position, head] = invocation.properties.arguments.oneOf;
	expect(position.properties.sourceRef.enum).toEqual([sourceRef]);
	expect(position.required).toEqual(["sourceRef", "cursor"]);
	expect(position.properties.start).toBeUndefined();
	expect(head.properties.cursor).toBeUndefined();
	const finishSchema = (output.oneOf ?? output.anyOf).find(
		(b: { properties: { action: { const: string } } }) =>
			b.properties.action.const === "finish",
	);
	const choices =
		finishSchema.properties.report.properties.claims.items.properties.evidence
			.items.oneOf;
	expect(choices).toHaveLength(1);
	expect(choices[0].properties.sourceId.const).toBe("same-source");
	expect(choices[0].properties.viewId.const).toBe(context.visible[0]!.viewId);
	expect(choices[0].properties.excerptId.enum).toEqual(["e0"]);
	const later = workerContext(
		{} as Task,
		prepared(),
		tools,
		[],
		[
			...operations,
			{
				tool: "tool:web.read_saved@1",
				state: "succeeded",
				arguments: data.nextInvocation.arguments,
			},
		],
	);
	expect(JSON.parse(later.messages[1]!.content).nextInvocation).toBeNull();
	expect(later.manifestDigest).toBe(context.manifestDigest);
	const overlapping = workerContext(
		{} as Task,
		prepared(),
		tools,
		[{ ...source("既読の範囲"), sourceRef, start: 4900, end: 7300 }],
		operations,
	);
	expect(
		JSON.parse(overlapping.messages[1]!.content).nextInvocation,
	).toBeNull();
});
test("needs rejection identifies the field without copying a rejected quote into diagnostics", () => {
	try {
		validateNeeds(
			[{ id: "n1", requestQuote: "rejected-private-text" }],
			"原文",
			true,
		);
		throw new Error("expected rejection");
	} catch (error) {
		expect(error).toBeInstanceOf(ValidationFailure);
		expect((error as ValidationFailure).issues).toEqual([
			{
				validationPath: "needs.0.requestQuote",
				validationCode: "verbatim_quote_required",
			},
		]);
		expect(JSON.stringify(error)).not.toContain("rejected-private-text");
	}
	expect(() => validateNeeds(undefined, "原文", true)).toThrow("invalid_needs");
	expect(() =>
		validateNeeds(
			[
				{ id: "same", requestQuote: "原文" },
				{ id: "same", requestQuote: "原文" },
			],
			"原文",
			false,
		),
	).toThrow("invalid_needs");
});
test("need state updates retain the host-bound original request and item; new and duplicated items still validate", () => {
	const original = {
			id: "n1",
			item: "必要な説明",
			requestQuote: "負数の扱い",
			status: "missing" as const,
		},
		previous = JSON.stringify([original]);
	const changed = {
		...original,
		item: "別の説明",
		requestQuote: "モデルの言換え",
		status: "confirmed" as const,
	};
	expect(
		canonicalNeeds([changed], "負数の扱いを確認して", previous, true),
	).toEqual([{ ...original, status: "confirmed" }]);
	expect(() =>
		canonicalNeeds([changed], "負数の扱いを確認して", null, true),
	).toThrow("invalid_needs");
	expect(() =>
		canonicalNeeds(
			[{ ...changed, id: "unknown" }],
			"負数の扱いを確認して",
			previous,
			true,
		),
	).toThrow("invalid_needs");
	expect(() =>
		canonicalNeeds([changed, changed], "負数の扱いを確認して", previous, true),
	).toThrow("invalid_needs");
	expect(() => canonicalNeeds([changed], "違う依頼", previous, true)).toThrow(
		"invalid_needs",
	);
	expect(() => canonicalNeeds(undefined, "負数の扱い", null, true)).toThrow(
		"invalid_needs",
	);
	expect(
		canonicalNeeds(undefined, "負数の扱い", previous, true),
	).toBeUndefined();
	const other = { ...original, id: "n2" };
	expect(
		canonicalNeeds(
			[changed],
			"負数の扱い",
			JSON.stringify([original, other]),
			true,
		),
	).toEqual([{ ...original, status: "confirmed" }, other]);
	expect(() =>
		canonicalNeeds(
			Array.from({ length: 8 }, (_, i) => ({ ...original, id: `new${i}` })),
			"負数の扱い",
			previous,
			true,
		),
	).toThrow("invalid_needs");
});
test("coordinator selection is limited to issued candidate references in both rendered and host schemas", () => {
	const candidateRef = crypto.randomUUID(),
		cards = [{ candidateRef, id: "web.research" }];
	const schema = coordinatorSchema("select", cards);
	const action = {
		action: "select",
		candidateRef,
		input: { question: "調査" },
	};
	expect(schema.safeParse(action).success).toBe(true);
	expect(
		schema.safeParse({ ...action, candidateRef: crypto.randomUUID() }).success,
	).toBe(false);
	expect(coordinatorSchema("select", []).safeParse(action).success).toBe(false);
	const context = coordinatorContext({ phase: "select" } as Task, cards);
	const rendered = JSON.parse(
		context.messages[0]!.content.split("OUTPUT_SCHEMA=")[1]!,
	);
	const selection = (rendered.oneOf ?? rendered.anyOf).find(
		(b: { properties: { action: { const: string } } }) =>
			b.properties.action.const === "select",
	);
	expect(selection.properties.candidateRef.enum).toEqual([candidateRef]);
});
test("request quote choices stay exact, bounded, and preserve Unicode for long and multiple needs", () => {
	for (const question of [
		"短い依頼",
		"😀".repeat(160),
		"😀".repeat(1000) + "終点。別項目を確認して。",
		"条件を確認して。".repeat(1000),
	]) {
		const options = requestQuotes(question);
		expect(options.length).toBeGreaterThan(0);
		expect(options.length).toBeLessThanOrEqual(6);
		expect(options.join("").length).toBeLessThanOrEqual(600);
		for (const quote of options) {
			expect(question).toContain(quote);
			expect(quote.length).toBeLessThanOrEqual(300);
			expect(quote).not.toMatch(/[\uD800-\uDBFF]$/u);
			expect(quote).not.toMatch(/^[\uDC00-\uDFFF]/u);
		}
	}
});
test("request quote choices for multiple specified URLs are short original clauses rather than URL fragments", () => {
	const question =
		"負数の行数上限を確認してください。まず https://example.com/first-document を読み、資料が目的に合わなければ https://example.com/second-document を読んで確認してください。";
	const options = requestQuotes(question);
	expect(options).toContain("資料が目的に合わなければ");
	for (const quote of options) {
		expect(question).toContain(quote);
		expect(quote).not.toContain("http");
	}
});
test("a failed find using an observed citation sourceId gets an explicit sourceRef retry example; arbitrary refs do not", () => {
	const s = { ...source("資料"), sourceRef: crypto.randomUUID() };
	const operation = {
		tool: "tool:web.find@1",
		state: "failed",
		arguments: { sourceRef: s.sourceId, query: "negative value" },
	};
	expect(correctedRead([operation], [s])).toEqual({
		action: "invoke",
		executionRef: "web.find",
		arguments: { sourceRef: s.sourceRef, query: "negative value" },
	});
	expect(
		correctedRead(
			[
				{
					...operation,
					arguments: { ...operation.arguments, sourceRef: crypto.randomUUID() },
				},
			],
			[s],
		),
	).toBeNull();
	expect(correctedRead([{ ...operation, state: "succeeded" }], [s])).toBeNull();
});
test("a saved read with a visible citation ID offers its issued sourceRef without executing or renewing the reference", () => {
	const s = { ...source("資料"), sourceRef: crypto.randomUUID() },
		cursor = crypto.randomUUID();
	const operation = {
		tool: "tool:web.read_saved@1",
		state: "failed",
		arguments: { sourceRef: s.sourceId, cursor, characters: 1800 },
	};
	expect(correctedRead([operation], [s])).toEqual({
		action: "invoke",
		executionRef: "web.read_saved",
		arguments: { sourceRef: s.sourceRef, cursor, characters: 1800 },
	});
	expect(
		correctedRead(
			[
				{
					...operation,
					arguments: { ...operation.arguments, sourceRef: crypto.randomUUID() },
				},
			],
			[s],
		),
	).toBeNull();
	expect(
		correctedRead(
			[{ ...operation, arguments: { ...operation.arguments, start: "head" } }],
			[s],
		),
	).toBeNull();
});
test("requested URL guidance starts with an unread URL and advances after a mismatched page without repeating it", () => {
	const p = prepared(),
		urls = ["https://example.com/first", "https://example.com/second"];
	p.input = { question: "指定URLの資料を調べて", urls };
	const tools = [
		{
			executionRef: "grant",
			tool: { id: "web.read", schemaKey: "read" as const },
		},
	];
	for (const count of [0, 1, 2]) {
		const context = workerContext(
			{} as Task,
			p,
			tools,
			urls.slice(0, count).map((url) => ({ ...source("対象外"), url })),
			[],
		);
		expect(JSON.parse(context.messages[1]!.content).nextInvocation).toEqual(
			count < 2
				? {
						action: "invoke",
						executionRef: "web.read",
						arguments: { url: urls[count] },
					}
				: null,
		);
	}
});
test("explicit current-request URLs survive omitted model metadata and remain bounded to three", () => {
	expect(
		requestUrls(
			"https://example.com/a を読み、次は https://example.com/b を確認して",
		),
	).toEqual(["https://example.com/a", "https://example.com/b"]);
	expect(
		requestUrls("引用（https://example.com/a）を読む", [
			"https://example.com/b",
		]),
	).toEqual(["https://example.com/b", "https://example.com/a"]);
	expect(
		requestUrls(
			"a https://a.example/ b https://b.example/ c https://c.example/ d https://d.example/",
		),
	).toHaveLength(3);
	expect(requestUrls("会話履歴を確認して")).toBeUndefined();
});
test("new read durations stay finite, reserve parent/final time, and preserve archived revision durations", () => {
	const now = 1000,
		p = prepared(),
		old = { ...p, dependencies: [] };
	expect(workerDeadline(p, now + 180000, now)).toBe(now + 150000);
	expect(workerDeadline(p, now + 120000, now)).toBe(now + 90000);
	expect(workerDeadline(old, now + 180000, now)).toBe(now + 90000);
	expect(() => workerDeadline(p, now + 30000, now)).toThrow(
		"agent_budget_exhausted",
	);
	const t = { kind: "worker", deadline: now + 150000, model_calls: 1 } as Task;
	expect(stepDeadline(t, p, now)).toBe(now + 45000);
	expect(stepDeadline(t, old, now)).toBe(now + 30000);
	expect(stepDeadline({ ...t, deadline: now + 10000 }, p, now)).toBe(
		now + 10000,
	);
	expect(
		explorationBudget({ ...t, deadline: now + 60000 }, p, [], now).canOperate,
	).toBe(false);
	expect(
		explorationBudget({ ...t, deadline: now + 61000 }, p, [], now).canOperate,
	).toBe(true);
});
test("coordinator URL metadata never enlarges the actual current-request scope", () => {
	const candidateRef = crypto.randomUUID(),
		cards = [{ candidateRef, id: "web.research" }];
	const schema = coordinatorSchema(
		"select",
		cards,
		"https://example.com/official を読んで",
	);
	const action = {
		action: "select",
		candidateRef,
		input: { question: "資料を確認", urls: ["https://example.com/official"] },
	};
	expect(schema.safeParse(action).success).toBe(true);
	expect(
		selectedInput(
			"https://example.com/official を読んで",
			{
				question: "資料を確認",
				urls: ["https://example.com/invented"],
				detail: "normal",
			},
			cards,
			candidateRef,
		),
	).toEqual({
		question: "https://example.com/official を読んで",
		urls: ["https://example.com/official"],
		detail: "normal",
	});
	expect(
		schema.safeParse({ ...action, input: { question: "資料を確認" } }).success,
	).toBe(true);
});
