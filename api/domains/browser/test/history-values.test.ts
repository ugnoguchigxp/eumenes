import { afterEach, expect, test } from "bun:test";
import { REDACTED_VALUE } from "../contracts/history";
import { OWNER, runCleanup } from "./fakes";
import {
	SITE,
	begin,
	finish,
	harness,
	histories,
	operate,
	publish,
	rowOf,
	type H,
} from "./history-fixture";

afterEach(runCleanup);

/** Where a run's values must not end up: the stored row and the source assembled from it (spec §3.2, §5, §6.3). */
const KEYWORD = "猫 癒し";
const variables = [{ name: "keyword", label: "検索語", value: KEYWORD }];
const detail = (h: H, id: string) => h.env.service.historyDetail(OWNER, id);

const ALL_SOURCES = (h: H, id: string) =>
	JSON.stringify(rowOf(h.env, id)) + detail(h, id).source;

test("item 1: variables survive a republish, and the values of every revision stay out of the history", async () => {
	const h = await harness();
	const OTHER = "犬 散歩";
	const t = await begin(h, `${KEYWORD}の動画を探して`);
	await publish(h, t, {
		variables,
		steps: [
			{
				label: `${KEYWORD}を探す`,
				expectation: "結果が出る",
				state: "running",
			},
		],
	});
	// Omitting `variables` keeps the declaration; an array replaces it.
	const kept = await publish(h, t, {});
	expect(kept.script.variables).toEqual(variables);
	const replaced = await publish(h, t, {
		variables: [{ name: "keyword", label: "検索語", value: OTHER }],
	});
	expect(replaced.script.variables?.[0]?.value).toBe(OTHER);
	const inherited = await publish(h, t, {});
	expect(inherited.script.variables).toEqual(replaced.script.variables);
	// Titles are checked against the effective values and every value an earlier revision declared.
	for (const value of [OTHER, KEYWORD])
		await expect(
			publish(h, t, { title: `${value}を検索する` }),
		).rejects.toThrow("script_title_has_value");
	const current = (await publish(h, t, {})).binding;
	await operate(
		h,
		t,
		{
			kind: "navigate",
			url: `${SITE}/results?q=${encodeURIComponent(KEYWORD)}`,
		},
		{
			binding: current,
			code: `await page.goto('${SITE}/results?q=${encodeURIComponent(KEYWORD)}');`,
		},
	);
	const grant = await h.env.service.grantFromRequest(OWNER, t, {
		value: KEYWORD,
		quote: KEYWORD,
		origin: SITE,
		purpose: "検索",
		variable: "keyword",
	});
	await operate(
		h,
		t,
		{
			kind: "type",
			element: "検索欄",
			inputValueRef: grant.inputValueRef,
			purpose: "検索",
			submit: false,
		},
		{
			binding: current,
			code: `await page.getByRole('combobox').fill('${KEYWORD}');`,
		},
	);
	await operate(
		h,
		t,
		{ kind: "click", element: `${OTHER}の動画` },
		{
			binding: current,
			code: `await page.getByRole('link', { name: '${OTHER} 1時間' }).click();`,
		},
	);
	await finish(h, t, { state: "completed" });
	const [summary] = histories(h.env);
	expect(summary).toMatchObject({
		request: "{{keyword}}の動画を探して",
		variables: [{ name: "keyword", label: "検索語" }],
	});
	const d = detail(h, summary!.historyId);
	expect(d.steps[0]!.label).toBe("{{keyword}}を探す");
	expect(d.actions.map((a) => a.variable)).toEqual([
		undefined,
		"keyword",
		undefined,
	]);
	expect(d.actions[2]).toMatchObject({
		element: "{{keyword}}の動画",
		code: "await page.getByRole('link', { name: '{{keyword}} 1時間' }).click();",
	});
	const stored = ALL_SOURCES(h, d.historyId);
	for (const value of [KEYWORD, OTHER, encodeURIComponent(KEYWORD)])
		expect(stored).not.toContain(value);
});

test("item 1: the values of every Script revision of every task in a chain stay out", async () => {
	const h = await harness();
	const FIRST = "最初の語";
	const SECOND = "次の語";
	const a = await begin(h, `${FIRST}を探して`);
	const pa = await publish(h, a, {
		variables: [{ name: "first", label: "最初", value: FIRST }],
	});
	await operate(
		h,
		a,
		{ kind: "navigate", url: `${SITE}/${encodeURIComponent(FIRST)}` },
		{
			binding: pa.binding,
			code: `await page.goto('${SITE}/${encodeURIComponent(FIRST)}');`,
		},
	);
	await finish(h, a, { state: "needs_input" });
	const b = await begin(h, `許可します（${SECOND}）`, { continueFrom: a });
	await publish(h, b, {
		variables: [{ name: "second", label: "次", value: SECOND }],
	});
	const pb = await publish(h, b, {
		variables: [{ name: "second", label: "次", value: SECOND }],
	});
	await operate(
		h,
		b,
		{ kind: "click", element: `${FIRST}と${SECOND}` },
		{ binding: pb.binding, code: `await p.getByText('${FIRST}').click();` },
	);
	await finish(h, b, { state: "completed" });
	const d = detail(h, histories(h.env)[0]!.historyId);
	expect(d.variables.map((v) => v.name)).toEqual(["second"]);
	expect(d.actions[0]!.url).toBe(`${SITE}/{{first}}`);
	expect(d.actions[1]).toMatchObject({
		element: "{{first}}と{{second}}",
		code: "await p.getByText(vars.first).click();",
	});
	const stored = ALL_SOURCES(h, d.historyId);
	for (const value of [FIRST, SECOND]) expect(stored).not.toContain(value);
});

test("item 2: the code kept with an operation holds no typed value unless it is the user's own words", async () => {
	const h = await harness();
	const t = await begin(h, `${KEYWORD}を探す。電話は 090-1234-5678 です`);
	const { binding } = await publish(h, t, { variables });
	await operate(h, t, { kind: "navigate", url: `${SITE}/` }, { binding });
	const typeWith = (inputValueRef: string, purpose: string, code: string) =>
		operate(
			h,
			t,
			{
				kind: "type",
				element: "欄",
				inputValueRef,
				purpose,
				submit: false,
			},
			{ binding, code },
		);
	// The stored code is cut at 4,000 characters; this one is cut inside the value.
	const padding = "x".repeat(3969);
	const asVariable = () =>
		h.env.service.grantFromRequest(OWNER, t, {
			value: KEYWORD,
			quote: KEYWORD,
			origin: SITE,
			purpose: "検索",
			variable: "keyword",
		});
	await typeWith(
		(await asVariable()).inputValueRef,
		"検索",
		`await page.locator('#q').fill('${KEYWORD}');`,
	);
	await typeWith(
		(await asVariable()).inputValueRef,
		"検索",
		`await page.locator('${padding}').fill('${KEYWORD}');`,
	);
	const own = await h.env.service.grantFromRequest(OWNER, t, {
		value: "09012345678",
		quote: "090-1234-5678",
		origin: SITE,
		purpose: "電話",
	});
	await typeWith(
		own.inputValueRef,
		"電話",
		"await page.getByLabel('電話').fill('09012345678');",
	);
	const allowed = await h.env.service.grantUserApproved(OWNER, t, {
		value: "s3cret-pass",
		origin: SITE,
		purpose: "合言葉",
	});
	await typeWith(
		allowed.inputValueRef,
		"合言葉",
		"await page.getByLabel('合言葉').pressSequentially('s3cret-pass');",
	);
	const codes = h.env.store.read(
		(db) =>
			db
				.query(
					"SELECT code FROM browser_operations WHERE task_id=? AND tool_kind='type' ORDER BY created_at, rowid",
				)
				.all(t) as { code: string }[],
	);
	expect(codes[0]!.code).toBe("await page.locator('#q').fill(vars.keyword);");
	expect(codes[1]!.code).toStartWith(`await page.locator('${padding}`);
	expect(codes[1]!.code).not.toContain("猫");
	expect(codes[2]!.code).toBe(
		"await page.getByLabel('電話').fill('09012345678');",
	);
	expect(codes[3]!.code).toBe(
		`await page.getByLabel('合言葉').pressSequentially('${REDACTED_VALUE}');`,
	);
	const all = JSON.stringify(
		h.env.store.read((db) =>
			db.query("SELECT * FROM browser_operations WHERE task_id=?").all(t),
		),
	);
	for (const value of [KEYWORD, "s3cret-pass"])
		expect(all).not.toContain(value);
});

test("item 3: a value in a URL's path, query or fragment and in the place is replaced; the code is made again from the URL", async () => {
	const h = await harness();
	const enc = encodeURIComponent(KEYWORD);
	const t = await begin(h, `${KEYWORD}を探す`);
	const { binding } = await publish(h, t, { variables });
	await operate(
		h,
		t,
		{ kind: "navigate", url: `${SITE}/tag/${enc}/top?x=${enc}#${enc}` },
		{
			binding,
			code: `await page.goto('${SITE}/tag/${enc}/top?x=${enc}#${enc}');`,
		},
	);
	await operate(
		h,
		t,
		{ kind: "navigate", url: `${SITE}/${enc}%E5%8B%95%E7%94%BB/` },
		{ binding, code: `await page.goto('${SITE}/%E7%8C%AB…');` },
	);
	await operate(
		h,
		t,
		{ kind: "tab_new", url: `${SITE}/new/${enc}` },
		{ binding },
	);
	await finish(h, t, { state: "completed" });
	const d = detail(h, histories(h.env)[0]!.historyId);
	const goto = (path: string) => `await page.goto(\`${SITE}${path}\`);`;
	expect(d.actions.map((a) => [a.kind, a.url, a.place, a.code])).toEqual([
		[
			"navigate",
			`${SITE}/tag/{{keyword}}/top?x={{keyword}}#{{keyword}}`,
			"www.example.com/tag/{{keyword}}/top",
			goto(
				"/tag/${encodeURIComponent(vars.keyword)}/top?x=${encodeURIComponent(vars.keyword)}#${encodeURIComponent(vars.keyword)}",
			),
		],
		[
			"navigate",
			`${SITE}/{{keyword}}%E5%8B%95%E7%94%BB/`,
			"www.example.com/{{keyword}}%E5%8B%95%E7%94%BB/",
			goto("/${encodeURIComponent(vars.keyword)}%E5%8B%95%E7%94%BB/"),
		],
		[
			"tab_new",
			`${SITE}/new/{{keyword}}`,
			"www.example.com/new/{{keyword}}",
			goto("/new/${encodeURIComponent(vars.keyword)}"),
		],
	]);
	const stored = ALL_SOURCES(h, d.historyId);
	for (const value of [KEYWORD, enc]) expect(stored).not.toContain(value);
});

test("item 5: the declared effect of a click, press or type is kept; only commit marks the history", async () => {
	const h = await harness();
	const t = await begin(h, "探す");
	const { binding } = await publish(h, t);
	await operate(h, t, { kind: "navigate", url: `${SITE}/` }, { binding });
	await operate(
		h,
		t,
		{ kind: "click", element: "メニュー", effect: "navigate" },
		{ binding },
	);
	await operate(
		h,
		t,
		{ kind: "press", key: "Tab", effect: "input" },
		{ binding },
	);
	const grant = await h.env.service.grantFromRequest(OWNER, t, {
		value: "探す",
		quote: "探す",
		origin: SITE,
		purpose: "検索",
	});
	await operate(
		h,
		t,
		{
			kind: "type",
			element: "検索欄",
			inputValueRef: grant.inputValueRef,
			purpose: "検索",
			submit: false,
			effect: "input",
		},
		{ binding },
	);
	await operate(h, t, { kind: "click", element: "別のメニュー" }, { binding });
	await finish(h, t, { state: "completed" });
	const [summary] = histories(h.env);
	expect(summary!.hasCommit).toBe(false);
	expect(
		detail(h, summary!.historyId).actions.map((a) => [a.kind, a.effect]),
	).toEqual([
		["navigate", undefined],
		["click", "navigate"],
		["press", "input"],
		["type", "input"],
		["click", undefined],
	]);
});
