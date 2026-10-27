import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { answerError } from "../../../application/app";
import { registerBrowser } from "..";
import {
	CATALOG_LIMIT,
	SOURCE_CHARS,
	type HistoryAction,
} from "../contracts/history";
import {
	containsValue,
	maskCode,
	maskPlace,
	maskUrl,
	replaceTypedArgument,
	replaceValues,
} from "../service/history-values";
import { buildSource, gotoCode } from "../service/history-source";
import { scriptPublish } from "../contracts/script";
import { OWNER, runCleanup } from "./fakes";
import { harness, histories, type H } from "./history-fixture";

afterEach(runCleanup);

const vars = [{ name: "keyword", value: "猫 癒し" }];

test("values: URL queries, typed arguments, literals and plain text lose the run's values", () => {
	expect(
		maskUrl("https://x.example/s?q=%E7%8C%AB+%E7%99%92%E3%81%97&lang=ja", vars),
	).toBe("https://x.example/s?q={{keyword}}&lang=ja");
	expect(maskUrl("https://x.example/s?q=%E7%8C%AB&n=1", vars)).toBe(
		"https://x.example/s?q=%E7%8C%AB&n=1",
	);
	expect(
		replaceTypedArgument("await p.fill('a\\'b', { x: 1 });", "vars.k"),
	).toBe("await p.fill(vars.k, { x: 1 });");
	expect(
		maskCode('await p.getByText("猫 癒し").click(); // 猫 癒し', vars),
	).toBe("await p.getByText(vars.keyword).click(); // 猫 癒し");
	expect(replaceValues("猫 癒しの動画", vars)).toBe("{{keyword}}の動画");
	expect(
		containsValue("ＹＯＵＴＵＢＥ検索", [{ name: "k", value: "youtube" }]),
	).toBe(true);
	expect(containsValue("abc", [{ name: "k", value: "b" }])).toBe(false);
});

test("§7: the source has the variables, a heading per step, the code as run and the escaped names", () => {
	const actions: HistoryAction[] = [
		{
			seq: 1,
			kind: "navigate",
			stepLabel: "開く",
			url: "https://www.youtube.com/results?q={{keyword}}",
			place: "www.youtube.com/results",
		},
		{
			seq: 2,
			kind: "type",
			stepLabel: "開く",
			element: "検索欄",
			variable: "keyword",
			code: "await page.getByRole('combobox').fill(vars.keyword);",
		},
		{ seq: 3, kind: "tab_select", stepLabel: "開く" },
		{ seq: 4, kind: "capture", stepLabel: "開く", value: "viewport" },
		{ seq: 5, kind: "click", stepLabel: "消えた手順", element: "戻る" },
	];
	const source = buildSource({
		title: "it's a\nname",
		request: "依頼\n二行目",
		variables: [{ name: "keyword", label: "検索語" }],
		steps: [
			{ label: "開く", expectation: "表示される" },
			{ label: "操作なし", expectation: "何もしない" },
		],
		actions,
		updatedAt: new Date(2026, 9, 27, 21, 4).getTime(),
		runCount: 3,
	});
	expect(source).toBe(`import { test } from '@playwright/test';

// 依頼: 依頼 二行目
// 保存: 2026-10-27 21:04（実行3回）
// 変数（実行ごとに今回の依頼から決める）
//   keyword: 検索語
const vars = { keyword: '' };

test('it\\'s a name', async ({ page }) => {
  // 1. 開く — 到達条件: 表示される
  await page.goto(\`https://www.youtube.com/results?q=\${encodeURIComponent(vars.keyword)}\`);
  await page.getByRole('combobox').fill(vars.keyword);
  // tab_select
  // 撮影（見えている範囲）: Eumenesの撮影画像に保存
  // 2. 操作なし — 到達条件: 何もしない
  // 手順に紐づかない操作
  // click: 戻る
});
`);
	expect(gotoCode("https://a.example/`${x}`")).toBe(
		"await page.goto('https://a.example/`${x}`');",
	);
	expect(gotoCode("https://a.example/{{keyword}}`")).toBe(
		"await page.goto(`https://a.example/${encodeURIComponent(vars.keyword)}\\``);",
	);
});

test("§7: a source over 24,000 characters is cut with the number of omitted operations", () => {
	const actions: HistoryAction[] = Array.from({ length: 40 }, (_, i) => ({
		seq: i + 1,
		kind: "click" as const,
		stepLabel: "押す",
		code: `await page.getByText('${"x".repeat(900)}${i}').click();`,
	}));
	const source = buildSource({
		title: "長い手順",
		request: "r",
		variables: [],
		steps: [{ label: "押す", expectation: "押される" }],
		actions,
		updatedAt: 0,
		runCount: 1,
	});
	expect(source.length).toBeLessThanOrEqual(SOURCE_CHARS);
	expect(source).toMatch(/\/\/ 以降の操作は省略（\d+件）\n\}\);\n$/);
	expect(source).not.toContain("const vars");
});

function app(h: H, owner = OWNER) {
	const a = new Hono();
	a.onError(answerError);
	registerBrowser(a, h.env.service, owner);
	return a;
}
const seed = (h: H, n: number, owner = OWNER, start = 0) =>
	h.env.store.write((db) => {
		for (let i = 0; i < n; i++)
			db.query(
				`INSERT INTO browser_histories(id,owner,title,request,place,variables_json,steps_json,actions_json,source_task_id,
				 revision,run_count,failure_count,last_outcome,has_commit,last_used_at,created_at,updated_at)
				 VALUES(?,?,?,?,?,?,?,?,NULL,1,2,0,'completed',0,?,?,?)`,
			).run(
				`00000000-0000-4000-8000-${String(start + i).padStart(12, "0")}`,
				owner,
				`手順${i}`.padEnd(100, "あ"),
				"依頼".repeat(100),
				"www.example.com",
				JSON.stringify(
					Array.from({ length: 7 }, (_, k) => ({
						name: `v${k}`,
						label: `説明${k}`,
						slots: [],
					})),
				),
				JSON.stringify(
					Array.from({ length: 8 }, (_, k) => ({
						label: `手順の名前${k}`.padEnd(60, "い"),
						expectation: "到達",
					})),
				),
				JSON.stringify([
					{
						seq: 1,
						kind: "navigate",
						url: "https://www.example.com/",
						code: "await page.goto('https://www.example.com/');",
						stepLabel: "手順の名前0",
					},
				]),
				1_000 + i,
				1,
				1_000 + i,
			);
	});

test("REST: the list is newest first, at most 100, never cached; a detail has the source; others' ids are 404", async () => {
	const h = await harness();
	await seed(h, 105);
	await seed(h, 1, "someone-else", 500);
	const a = app(h);
	const list = await a.request("/api/browser/histories");
	expect(list.status).toBe(200);
	expect(list.headers.get("Cache-Control")).toBe("no-store");
	const { histories: rows } = (await list.json()) as {
		histories: Array<Record<string, unknown>>;
	};
	expect(rows).toHaveLength(100);
	expect(rows[0]!.lastUsedAt).toBe(1_104);
	expect(Object.keys(rows[0]!).sort()).toEqual(
		[
			"createdAt",
			"failureCount",
			"hasCommit",
			"historyId",
			"lastOutcome",
			"lastUsedAt",
			"place",
			"request",
			"revision",
			"runCount",
			"stepCount",
			"title",
			"updatedAt",
			"variables",
		].sort(),
	);
	expect(rows[0]!.variables).toHaveLength(7);
	expect(rows[0]!.variables).toEqual(
		expect.arrayContaining([{ name: "v0", label: "説明0" }]),
	);
	const id = rows[0]!.historyId as string;
	const one = await a.request(`/api/browser/histories/${id}`);
	expect(one.headers.get("Cache-Control")).toBe("no-store");
	const { history } = (await one.json()) as {
		history: { source: string; steps: unknown[]; actions: unknown[] };
	};
	expect(history.steps).toHaveLength(8);
	expect(history.actions).toEqual([
		{
			seq: 1,
			kind: "navigate",
			stepLabel: "手順の名前0",
			url: "https://www.example.com/",
			code: "await page.goto('https://www.example.com/');",
		},
	]);
	expect(history.source).toContain("import { test } from '@playwright/test';");
	const missing = await a.request(
		"/api/browser/histories/11111111-1111-4111-8111-111111111111",
	);
	expect(missing.status).toBe(404);
	expect(await missing.json()).toMatchObject({
		error: "browser_history_not_found",
	});
	expect(
		(await app(h, "intruder").request(`/api/browser/histories/${id}`)).status,
	).toBe(404);
	expect((await a.request("/api/browser/histories/not-an-id")).status).toBe(
		400,
	);
});

test("REFERENCE catalog: the newest twelve, each bounded; the operator view has the steps and actions", async () => {
	const h = await harness();
	await seed(h, 15);
	const api = (await import("./history-fixture")).apiOf;
	const task = await (await import("./history-fixture")).begin(h, "依頼");
	const catalog = api(h, task).histories();
	expect(catalog).toHaveLength(CATALOG_LIMIT);
	expect(catalog[0]).toMatchObject({
		runs: 2,
		lastOutcome: "completed",
		lastUsed: "1970-01-01",
		place: "www.example.com",
	});
	expect(catalog[0]!.title.startsWith("手順14")).toBe(true);
	expect(catalog[0]!.title).toHaveLength(60);
	expect(catalog[0]!.request).toHaveLength(80);
	expect(catalog[0]!.variables).toHaveLength(5);
	expect(catalog[0]!.steps).toHaveLength(6);
	expect(catalog[0]!.steps[0]).toHaveLength(40);
	const id = catalog[0]!.historyId;
	const view = api(h, task).history(id);
	expect(view).toMatchObject({
		historyId: id,
		revision: 1,
		title: expect.any(String),
	});
	expect(view.actions[0]).toMatchObject({
		seq: 1,
		step: "手順の名前0",
		kind: "navigate",
	});
	expect(view.actions[0]).not.toHaveProperty("stepLabel");
	expect(() => api(h, task).history(crypto.randomUUID())).toThrow(
		"browser_history_not_found",
	);
});

test("delete: at the revision shown; a changed revision conflicts and nothing is deleted", async () => {
	const h = await harness();
	await seed(h, 2);
	const [first, second] = histories(h.env);
	const del = (historyId: string, expectedRevision: number, owner = OWNER) =>
		h.env.store.write((db) =>
			h.env.service.deleteHistoryInTransaction(db, owner, {
				historyId,
				expectedRevision,
			}),
		);
	await expect(del(first!.historyId, 5)).rejects.toThrow(
		"browser_history_conflict",
	);
	await expect(del(first!.historyId, 1, "intruder")).rejects.toThrow(
		"browser_history_not_found",
	);
	expect(histories(h.env)).toHaveLength(2);
	expect(await del(first!.historyId, 1)).toEqual({
		historyId: first!.historyId,
	});
	expect(histories(h.env).map((x) => x.historyId)).toEqual([second!.historyId]);
	await expect(del(first!.historyId, 1)).rejects.toThrow(
		"browser_history_not_found",
	);
});

test("Script v2: the title is required; variables are named, at most five and without duplicates", () => {
	const base = {
		expectedRevision: 0,
		title: "手順",
		summary: "解釈",
		steps: [{ label: "a", expectation: "b", state: "running" }],
	};
	const variable = (name: string, value = "値") => ({
		name,
		label: "説明",
		value,
	});
	expect(scriptPublish.safeParse(base).success).toBe(true);
	expect(scriptPublish.safeParse({ ...base, title: undefined }).success).toBe(
		false,
	);
	expect(
		scriptPublish.safeParse({ ...base, title: "x".repeat(61) }).success,
	).toBe(false);
	for (const name of ["Keyword", "1a", "a-b", "a".repeat(32)])
		expect(
			scriptPublish.safeParse({ ...base, variables: [variable(name)] }).success,
		).toBe(false);
	expect(
		scriptPublish.safeParse({ ...base, variables: [variable("a".repeat(31))] })
			.success,
	).toBe(true);
	expect(
		scriptPublish.safeParse({
			...base,
			variables: ["a", "b", "c", "d", "e", "f"].map((n) => variable(n)),
		}).success,
	).toBe(false);
	expect(
		scriptPublish.safeParse({
			...base,
			variables: [variable("a"), variable("a")],
		}).success,
	).toBe(false);
	expect(
		scriptPublish.safeParse({
			...base,
			variables: [variable("a", "x".repeat(201))],
		}).success,
	).toBe(false);
	expect(scriptPublish.safeParse({ ...base, historyId: "no" }).success).toBe(
		false,
	);
});

test("item 3: a value in a path segment, query value or fragment is replaced after decoding; the rest stays", () => {
	const k = [{ name: "keyword", value: "猫 癒し" }];
	const enc = encodeURIComponent("猫 癒し");
	expect(
		maskUrl(`https://x.example/tag/${enc}/top?x=${enc}&n=1#${enc}`, k),
	).toBe("https://x.example/tag/{{keyword}}/top?x={{keyword}}&n=1#{{keyword}}");
	// A value inside a longer segment or query value leaves the other parts encoded.
	expect(
		maskUrl(
			`https://x.example/${enc}%E5%8B%95%E7%94%BB/a?q=%E9%81%8A+${enc}`,
			k,
		),
	).toBe(
		"https://x.example/{{keyword}}%E5%8B%95%E7%94%BB/a?q=%E9%81%8A%20{{keyword}}",
	);
	// Case and width do not matter in the URL either; unrelated URLs are untouched.
	expect(
		maskUrl("https://x.example/ＹＯＵ/y?q=you", [{ name: "v", value: "you" }]),
	).toBe("https://x.example/{{v}}/y?q={{v}}");
	expect(maskUrl("https://x.example/a%ZZ/b?c=%", k)).toBe(
		"https://x.example/a%ZZ/b?c=%",
	);
	expect(maskPlace(`x.example/tag/${enc}/top`, k)).toBe(
		"x.example/tag/{{keyword}}/top",
	);
});

test("item 6: a value is replaced only inside the string literals of a code line", () => {
	const v = [{ name: "word", value: "page" }];
	expect(maskCode("await page.getByText('page 1').click();", v)).toBe(
		"await page.getByText('{{word}} 1').click();",
	);
	expect(maskCode('await page.getByText("page").click();', v)).toBe(
		"await page.getByText(vars.word).click();",
	);
	expect(maskCode("await page.locator('.page').count();", v)).toBe(
		"await page.locator('.{{word}}').count();",
	);
	// Escapes are read as written and kept as written around the replacement.
	const quote = [{ name: "q", value: "it's" }];
	expect(maskCode("await p.getByText('x it\\'s \\'y').click();", quote)).toBe(
		"await p.getByText('x {{q}} \\'y').click();",
	);
	expect(maskCode("await p.getByText('it\\'s').click();", quote)).toBe(
		"await p.getByText(vars.q).click();",
	);
	// Identifiers, property names and punctuation outside a literal are never touched.
	expect(maskCode("const page = { page: 1 }; page.fill('a');", v)).toBe(
		"const page = { page: 1 }; page.fill('a');",
	);
	// A template literal does not open an interpolation from a replacement.
	expect(maskCode("p.goto(`$page/x`);", v)).toBe("p.goto(`$\\{{word}}/x`);");
});

test("item 7: U+2028 and U+2029 break a line in the source like a newline", () => {
	const source = buildSource({
		title: "a\u2028b",
		request: "x\u2029y",
		variables: [{ name: "keyword", label: "l\u2028m" }],
		steps: [{ label: "s\u2028t", expectation: "e\u2029f" }],
		actions: [
			{ seq: 1, kind: "click", stepLabel: "s\u2028t", element: "p\u2028q" },
		],
		updatedAt: 0,
		runCount: 1,
	});
	expect(source).not.toMatch(/[\u2028\u2029]/);
	expect(source).toContain("// 依頼: x y");
	expect(source).toContain("test('a b'");
	expect(source).toContain("//   keyword: l m");
	expect(source).toContain("// 1. s t — 到達条件: e f");
	expect(source).toContain("// click: p q");
});

test("item 8: the title check and every replacement use one matcher", () => {
	const cases: [string, string, boolean][] = [
		["youtube", "YouTubeで検索", true],
		["youtube", "ＹＯＵＴＵＢＥ検索", true],
		["ＹＯＵＴＵＢＥ", "youtube検索", true],
		["ﾈｺ", "ネコの動画", true],
		["猫 癒し", "猫 癒し", true],
		["abc", "xaBcx", true],
		["b", "abc", false],
		["abc", "ab", false],
	];
	for (const [value, text, hit] of cases) {
		const k = [{ name: "k", value }];
		expect(containsValue(text, k)).toBe(hit);
		expect(replaceValues(text, k) !== text).toBe(hit);
		if (hit) expect(replaceValues(text, k)).toContain("{{k}}");
	}
	expect(
		replaceValues("ＹＯＵＴＵＢＥ と YouTube", [
			{ name: "k", value: "youtube" },
		]),
	).toBe("{{k}} と {{k}}");
	// Longer values go first, so the longer one is replaced whole.
	expect(
		replaceValues("猫 癒しと猫", [
			{ name: "short", value: "猫" },
			{ name: "long", value: "猫 癒し" },
		]),
	).toBe("{{long}}と{{short}}");
	// The same matcher replaces inside code literals and URL parts.
	expect(
		maskCode("p.getByText('ＹＯＵ tube')", [{ name: "k", value: "you tube" }]),
	).toBe("p.getByText(vars.k)");
	expect(
		maskUrl("https://x.example/YOUTUBE", [{ name: "k", value: "youtube" }]),
	).toBe("https://x.example/{{k}}");
});
