import {
	SOURCE_CHARS,
	variableNamePattern,
	type HistoryAction,
	type HistoryStep,
	type HistoryVariable,
} from "../contracts/history";

/**
 * The Playwright source of a history, assembled on read and never stored (spec browser-run-history §7). It is
 * for reading and copying; it is not promised to run, since it assumes the user's own logged-in browser.
 */
export type SourceInput = {
	title: string;
	request: string;
	variables: HistoryVariable[];
	steps: HistoryStep[];
	actions: HistoryAction[];
	updatedAt: number;
	runCount: number;
};

const oneLine = (text: string) =>
	text.replace(/\s*[\r\n\u2028\u2029]+\s*/g, " ");
const quoted = (text: string) =>
	`'${oneLine(text).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
const placeholder = /\{\{([a-z][a-zA-Z0-9]{0,30})\}\}/g;

/** `page.goto` of a URL; a `{{name}}` in it becomes the encoded variable. */
export function gotoCode(url: string) {
	if (!url.includes("{{")) return `await page.goto(${quoted(url)});`;
	let out = "";
	let last = 0;
	const escape = (s: string) => s.replace(/[\\`]|\$\{/g, (m) => `\\${m}`);
	for (const m of url.matchAll(placeholder)) {
		if (!variableNamePattern.test(m[1]!)) continue;
		out += `${escape(url.slice(last, m.index))}\${encodeURIComponent(vars.${m[1]})}`;
		last = m.index + m[0].length;
	}
	return `await page.goto(\`${out}${escape(url.slice(last))}\`);`;
}

const RANGE_LABEL: Record<string, string> = {
	viewport: "見えている範囲",
	"full-page": "ページ全体",
	element: "要素",
};

/** The lines of one operation; without code, a comment that names it. */
function actionLines(a: HistoryAction) {
	if (a.code) return a.code.split("\n");
	if (a.kind === "navigate" && a.url) return [gotoCode(a.url)];
	if (a.kind === "capture")
		return [
			`// 撮影（${RANGE_LABEL[a.value ?? ""] ?? a.value ?? ""}）: Eumenesの撮影画像に保存`,
		];
	const what = a.element ?? a.url ?? a.value;
	return [`// ${a.kind}${what ? `: ${oneLine(what)}` : ""}`];
}

const two = (n: number) => String(n).padStart(2, "0");
function stamp(ms: number) {
	const d = new Date(ms);
	return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

export function buildSource(h: SourceInput) {
	const head = [
		"import { test } from '@playwright/test';",
		"",
		`// 依頼: ${oneLine(h.request)}`,
		`// 保存: ${stamp(h.updatedAt)}（実行${h.runCount}回）`,
	];
	if (h.variables.length) {
		head.push("// 変数（実行ごとに今回の依頼から決める）");
		for (const v of h.variables)
			head.push(`//   ${v.name}: ${oneLine(v.label)}`);
		head.push(
			`const vars = { ${h.variables.map((v) => `${v.name}: ''`).join(", ")} };`,
		);
	}
	head.push("", `test(${quoted(h.title)}, async ({ page }) => {`);

	// Each operation belongs to the first step with its label; the rest follow the steps.
	const owner = new Map<HistoryAction, number>();
	for (const a of h.actions) {
		const i = h.steps.findIndex((s) => s.label === a.stepLabel);
		if (i !== -1) owner.set(a, i);
	}
	const sections: { heading: string; actions: HistoryAction[] }[] = h.steps.map(
		(s, i) => ({
			heading: `// ${i + 1}. ${oneLine(s.label)} — 到達条件: ${oneLine(s.expectation)}`,
			actions: h.actions.filter((a) => owner.get(a) === i),
		}),
	);
	const loose = h.actions.filter((a) => !owner.has(a));
	if (loose.length)
		sections.push({ heading: "// 手順に紐づかない操作", actions: loose });

	const lines = [...head];
	let used = lines.join("\n").length;
	let remaining = h.actions.length;
	let omitted = false;
	const push = (text: string, counts: boolean) => {
		if (omitted) return;
		if (used + text.length + 1 > SOURCE_CHARS - 120) {
			omitted = true;
			return;
		}
		lines.push(text);
		used += text.length + 1;
		if (counts) remaining--;
	};
	for (const section of sections) {
		push(`  ${section.heading}`, false);
		for (const a of section.actions)
			push(
				actionLines(a)
					.map((l) => `  ${l}`)
					.join("\n"),
				true,
			);
	}
	if (omitted) lines.push(`  // 以降の操作は省略（${remaining}件）`);
	lines.push("});");
	return `${lines.join("\n")}\n`;
}
