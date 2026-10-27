import { expect, test } from "bun:test";
import type { HistoryAction } from "../contracts/history";
import { REDACTED_VALUE } from "../contracts/history";
import {
	checkReplayCode,
	planReplay,
	replayFunction,
	replayLines,
	replayPreview,
	replayTabUrl,
} from "../service/replay-code";

const declared = ["keyword"];
const values = { keyword: "AI 関連&x" };
const check = (code: string, names = declared, given = values) =>
	checkReplayCode(code, names, given);

const YOUTUBE = `await page.getByRole('combobox', { name: '検索' }).fill(vars.keyword);
await page.keyboard.press('Enter');
await page.waitForURL('**/results?search_query=**');
await page.locator('ytd-video-renderer').first().waitFor();
const videos = page.locator('ytd-video-renderer a#video-title');
const count = await videos.count();
await videos.nth(Math.floor(Math.random() * count)).click();
await page.waitForURL('**/watch?v=**', { timeout: 15000 });`;

test("§3.2: the recorded code of a search-and-play history passes", () => {
	expect(check(YOUTUBE)).toEqual({ ok: true, gotoUrls: [] });
});

test("page.goto takes a string or the one template, and its address is worked out with the run's values", () => {
	expect(check("await page.goto('https://www.youtube.com/');")).toEqual({
		ok: true,
		gotoUrls: ["https://www.youtube.com/"],
	});
	expect(
		check(
			"await page.goto(`https://www.youtube.com/results?search_query=${encodeURIComponent(vars.keyword)}`);",
		),
	).toEqual({
		ok: true,
		gotoUrls: [
			`https://www.youtube.com/results?search_query=${encodeURIComponent("AI 関連&x")}`,
		],
	});
	expect(
		check("await page.goto('https://a.example/', { waitUntil: 'load' });"),
	).toMatchObject({ ok: true });
});

test("names: only page, vars, Math.floor/random, the fixed words, Playwright's methods and the code's own declarations", () => {
	for (const code of [
		"await page.click('a'); require('fs');",
		"process.exit();",
		"globalThis.fetch('https://x.example');",
		"await import('fs');",
		"eval('1');",
		"new Function('return 1')();",
		"Bun.file('/etc/passwd');",
		"await page.constructor.constructor('return process')();",
		"const constructor = 1; await page.constructor.x();",
		"await page.locator('a').click(fetch);",
		"Math.constructor;",
		"Math.max(1, 2);",
		"x = 1;",
		"await vars.other;",
		"await page.goBack().then(1);",
		"await page.context().close();",
		"await page.screenshot({ path: '/tmp/x.png' });",
	])
		expect(check(code), code).toEqual({ ok: false });
});

test("computed member reads, arrows and the page-side JavaScript APIs are refused", () => {
	for (const code of [
		"const x = page; x['constructor'];",
		"const x = page; x?.['constructor'];",
		"await page.locator('a')['click']();",
		"const f = () => 1;",
		"const f = async (a) => a;",
		"function f() {}",
		"await page.evaluate(() => 1);",
		"await page.locator('a').evaluate('1');",
		"await page.locator('a').evaluateHandle('1');",
		"await page.addInitScript('1');",
		"await page.exposeFunction('x', 1);",
		"await page.exposeBinding('x', 1);",
		"await page.route('**', 1);",
		"await page.routeFromHAR('x.har');",
		"await page.setInputFiles('input', '/etc/passwd');",
		"await page.locator('input').setInputFiles('/etc/passwd');",
	])
		expect(check(code), code).toEqual({ ok: false });
	// An array literal is not a read.
	expect(
		check("await page.locator('s').selectOption(['a', 'b']);"),
	).toMatchObject({ ok: true });
	expect(
		check("await page.mouse.click(1, 2, { modifiers: ['Shift'] });"),
	).toMatchObject({ ok: true });
});

test("a template may hold only encodeURIComponent(vars.<declared>)", () => {
	expect(
		check(
			"await page.getByText(`a${encodeURIComponent(vars.keyword)}b`).click();",
		),
	).toMatchObject({ ok: true });
	for (const code of [
		"await page.getByText(`${process.exit()}`).click();",
		"await page.getByText(`${vars.keyword}`).click();",
		"await page.getByText(`${encodeURIComponent(vars.other)}`).click();",
		"await page.getByText(`${encodeURIComponent(page.url())}`).click();",
		"await page.getByText(`${1 + 1}`).click();",
		"await page.getByText(`${`${vars.keyword}`}`).click();",
	])
		expect(check(code), code).toEqual({ ok: false });
});

test("page.goto never takes anything but a string literal or the template", () => {
	for (const code of [
		"await page.goto(vars.keyword);",
		"await page.goto('https://a.example/' + vars.keyword);",
		"const u = 'https://a.example/'; await page.goto(u);",
		"await page.goto(`https://a.example/${encodeURIComponent(vars.keyword)}` + 'x');",
		"const go = page.goto; await go('https://a.example/');",
		"await page.goto();",
		"await page.goto('https://a.example/'.concat('x'));",
	])
		expect(check(code), code).toEqual({ ok: false });
});

test("code that cannot be split into tokens with certainty is refused", () => {
	for (const code of [
		"await page.getByText('open",
		"await page.getByText(`open",
		"/* never closed",
		"await page.click('a'); #private",
		"await page.click('a'); @x",
		"await page.waitForURL(/open",
		"await page.waitForURL(/watch/);",
		"const r = /a/;",
		"await page.click('a') }",
		"await page.click('a'); {",
		"await page.getByText('a\\\nb').click();",
		"await page.getByText(' ').click();   process.exit();",
		"x <!-- y\nawait page.click('a');",
		"-->\nawait page.click('a');",
		"let n = 10n;",
	])
		expect(check(code), code).toEqual({ ok: false });
});

test("regular expressions are not part of the language; a division is read only where it cannot be a regex", () => {
	for (const code of [
		"await page.waitForURL(/watch/);",
		"await page.waitForURL(/a\\/b[/]c/i);",
		"{}\n/'/; process.exit(); //'/\nawait page.click('a');",
		"let n = 1; n++ / 2;",
		"await /x/.test('a');",
	])
		expect(check(code), code).toEqual({ ok: false });
	expect(check("const a = 4; const b = a / 2 / 1;")).toMatchObject({
		ok: true,
	});
});

test("a declared name is visible from its declaration to the end of its block", () => {
	expect(check("{ const process = 1; }\nprocess.exit();")).toEqual({
		ok: false,
	});
	expect(check("process.exit();\nconst process = 1;")).toEqual({ ok: false });
	expect(
		check("const a = 1;\n{ const b = a; await page.click('x'); }"),
	).toMatchObject({ ok: true });
	expect(check("const page = 1;")).toEqual({ ok: false });
	expect(check("const evaluate = 1;")).toEqual({ ok: false });
	expect(check("const a = { name: 'x', exact: true };")).toMatchObject({
		ok: true,
	});
	expect(check("const a = { constructor: 1 };")).toEqual({ ok: false });
	expect(check("const a = { other: 1 };")).toEqual({ ok: false });
});

test("nothing can be assigned, so the checked address is the one that runs", () => {
	for (const code of [
		"vars.keyword = '127.0.0.1'; await page.goto(`https://${encodeURIComponent(vars.keyword)}/`);",
		"vars.site = '127.0.0.1';",
		"page = page.locator('a');",
		"page.url = Math.floor;",
		"Math.floor = Math.random;",
		"const encodeURIComponent = Math.floor;",
		"const vars = { keyword: '127.0.0.1' };",
		"const Math = { floor: 1 };",
		"const a = 1; a += 1;",
		"const a = 1; a -= 1;",
		"const a = 1; a *= 2;",
		"const a = 1; a /= 2;",
		"const a = 1; a %= 2;",
		"const a = 1; a **= 2;",
		"let a = 1; a &&= 2;",
		"let a = 1; a ||= 2;",
		"let a = 1; a ??= 2;",
		"let a = 1; a <<= 2;",
		"let a = 1; a >>= 2;",
		"let a = 1; a >>>= 2;",
		"let a = 1; a &= 2;",
		"let a = 1; a |= 2;",
		"let a = 1; a ^= 2;",
		"let a = 1; a++;",
		"let a = 1; --a;",
		"let a = 1; a = 2;",
		"const a = 1, b = 2;",
		"const { a } = page;",
		"{ const vars = 1; }",
	])
		expect(check(code), code).toEqual({ ok: false });
	// A declaration's initializer is the one assignment, and a comparison is not one.
	expect(
		check("const n = 3; const same = n === 3 && n != 4 && n <= 5; let m = n;"),
	).toMatchObject({ ok: true });
	expect(check("const count = await page.locator('a').count();")).toMatchObject(
		{ ok: true },
	);
});

test("§6: generated forms are accepted: contentFrame, frame filters, the wait codes MCP writes", () => {
	for (const code of [
		"await page.locator('iframe').contentFrame().getByRole('button', { name: '再生', exact: true }).click();",
		"await page.getByRole('button', {\n  name: '送信'\n}).click({\n  button: 'right'\n});",
		"await page.locator('li').filter({ hasNot: page.locator('b'), visible: true }).first().hover();",
		"await page.getByText(\"読み込み完了\").first().waitFor({ state: 'visible' });",
		"await page.getByText(\"広告\").first().waitFor({ state: 'hidden' });",
		"// Press Enter\nawait page.keyboard.press('Enter');",
		"await page.getByRole('textbox', { name: '検索' }).pressSequentially('abc');",
		"await page.getByRole('textbox', { name: '検索' }).press('Enter');",
		"await page.getByRole('combobox').selectOption(['a', 'b']);",
		"await page.goBack();",
		"await page.getByRole('checkbox').check();",
	])
		expect(check(code), code).toMatchObject({ ok: true });
	// A frame is no way around the address check.
	expect(
		check(
			"await page.locator('iframe').contentFrame().goto('http://127.0.0.1/');",
		),
	).toEqual({ ok: false });
});

test("MCP's wait-for-seconds code is rewritten to its allowed equivalent, exactly and nothing else", () => {
	const generated = "await new Promise(f => setTimeout(f, 3 * 1000));";
	expect(check(generated)).toEqual({ ok: false });
	const lines = replayLines([{ seq: 1, kind: "wait", code: generated }]);
	expect(lines).toEqual(["await page.waitForTimeout(3000);"]);
	expect(check(lines!.join("\n"))).toMatchObject({ ok: true });
	expect(
		replayLines([
			{
				seq: 1,
				kind: "wait",
				code: "await new Promise(f => setTimeout(f, 0.5 * 1000));",
			},
		]),
	).toEqual(["await page.waitForTimeout(500);"]);
	// Anything that merely resembles it is left as it is, and so refused.
	for (const code of [
		"await new Promise(f => setTimeout(f, 3 * 1000)); await page.evaluate(1);",
		"await new Promise(f => setTimeout(f, vars.keyword * 1000));",
		"await new Promise(r => setTimeout(r, 3 * 1000));",
	])
		expect(
			planReplay([{ seq: 1, kind: "wait", code }], declared, values),
			code,
		).toMatchObject({ ok: false, code: "replay_code_rejected" });
});

test("an operation that would type the redaction placeholder cannot be replayed", () => {
	expect(
		replayLines([
			{
				seq: 1,
				kind: "type",
				value: REDACTED_VALUE,
				code: "await page.locator('input').fill('x');",
			},
		]),
	).toBeNull();
	expect(
		replayLines([
			{
				seq: 1,
				kind: "type",
				code: `await page.locator('input').fill('${REDACTED_VALUE}');`,
			},
		]),
	).toBeNull();
});

test("the preview is the plan of a start: the same lines, whole, and the same refusals", () => {
	const actions: HistoryAction[] = [
		{ seq: 2, kind: "click", code: "await page.reload();" },
		{ seq: 1, kind: "navigate", url: "https://x.example/s?q={{keyword}}" },
		...Array.from({ length: 40 }, (_, i) => ({
			seq: 3 + i,
			kind: "click" as const,
			code: `await page.getByText('${"あ".repeat(900)}${i}').click();`,
		})),
	];
	const preview = replayPreview(actions, declared);
	const plan = planReplay(actions, declared, values);
	expect(plan.ok).toBe(true);
	expect(preview).toEqual({
		code: plan.lines.join("\n"),
		blocked: null,
		blockedLabel: null,
	});
	expect(preview.code.length).toBeGreaterThan(24_000);
	expect(
		preview.code.startsWith("await page.goto(`https://x.example/s?q="),
	).toBe(true);
	expect(replayPreview([{ seq: 1, kind: "press" }], [])).toEqual({
		code: "",
		blocked: "replay_incomplete",
		blockedLabel: "記録されていない操作や値があるため実行できません",
	});
	const rejected = replayPreview(
		[{ seq: 1, kind: "click", code: "await page.evaluate(1);" }],
		[],
	);
	expect(rejected).toEqual({
		code: "await page.evaluate(1);",
		blocked: "replay_code_rejected",
		blockedLabel: "このコードは安全のため実行できません",
	});
});

test("assembly: operations in seq order, a navigation without code as goto, captures skipped, the rest need code", () => {
	const actions: HistoryAction[] = [
		{ seq: 3, kind: "click", code: "await page.getByText('b').click();" },
		{ seq: 1, kind: "navigate", url: "https://x.example/s?q={{keyword}}" },
		{ seq: 2, kind: "capture", value: "viewport" },
	];
	const lines = replayLines(actions)!;
	expect(lines).toEqual([
		"await page.goto(`https://x.example/s?q=${encodeURIComponent(vars.keyword)}`);",
		"await page.getByText('b').click();",
	]);
	expect(replayLines([...actions, { seq: 4, kind: "press" }])).toBeNull();
	expect(replayLines([{ seq: 1, kind: "capture" }])).toBeNull();
	expect(replayLines([{ seq: 1, kind: "navigate" }])).toBeNull();
});

test("assembly embeds the values as frozen JSON in a strict function, so a value is never read as code", async () => {
	const hostile = { keyword: '"; process.exit(); //' + "`${x}` " };
	const code = replayFunction(["await page.click('a');"], hostile);
	expect(
		code.startsWith(
			"async (page) => {\n'use strict';\nconst vars = Object.freeze(",
		),
	).toBe(true);
	expect(code).toContain(JSON.stringify(hostile));
	// The function evaluates to a function whose `vars` holds the value verbatim.
	const probe = replayFunction(["return vars;"], hostile);
	const run = new Function(`return (${probe})`)() as (
		p: unknown,
	) => Promise<unknown>;
	expect(await run({})).toEqual(hostile);
	const mutate = replayFunction(["vars.keyword = 'x';"], hostile);
	const mutating = new Function(`return (${mutate})`)() as (
		p: unknown,
	) => Promise<unknown>;
	await expect(mutating({})).rejects.toThrow();
});

test("the tab address is https://<place> with each {{name}} encoded", () => {
	expect(replayTabUrl("www.youtube.com", {})).toBe("https://www.youtube.com");
	expect(replayTabUrl("{{site}}.example", { site: "a b" })).toBe(
		"https://a%20b.example",
	);
	expect(replayTabUrl("{{site}}.example", {})).toBe("https://{{site}}.example");
});
