/**
 * Judging, timing and aggregation of the harness measurement (the conversation harness design, section 5.1): whether
 * a turn passed its step and why not, what the user waited for, and the chain x form table. Pure functions.
 */
import type { CallMetrics } from "./harness-client";
import type { Step } from "./harness-chains";

export type Turn = {
	/** The words the user hears: the reply, or the announcement of a hand-over. */
	said: string;
	/** The turn searched or handed over (a refused call counts). */
	acted: boolean;
	delegated?: { toolchain: string; request: string };
	error?: string;
};

const norm = (text: string) => text.replace(/\s+/g, "");

/** The longest run of characters two texts share. */
export function commonRun(a: string, b: string): number {
	let best = 0;
	for (let i = 0; i < a.length; i++)
		for (let j = 0; j < b.length; j++) {
			let k = 0;
			while (a[i + k] !== undefined && a[i + k] === b[j + k]) k++;
			if (k > best) best = k;
		}
	return best;
}

/**
 * Whether the turn did what its step asks. A reply that copies the system part (`copies`, the product's gate)
 * fails first; `lastAgent` is the agent's last reply before the step (what a re-saying repeats).
 */
export function judgeStep(
	step: Step,
	turn: Turn,
	context: { copies: (text: string) => boolean; lastAgent: string },
): { pass: boolean; why: string } {
	const fail = (why: string) => ({ pass: false, why });
	const ok = { pass: true, why: "" };
	if (turn.error) return fail(`error ${turn.error.slice(0, 60)}`);
	if (context.copies(turn.said)) return fail("system を写した");
	if (step.free) return ok;
	if (step.notBroken)
		return turn.acted
			? fail("担当を呼んだ")
			: norm(turn.said).includes("先ほどの再生は記憶にない")
				? fail("壊れた返事を繰り返した")
				: ok;
	if (step.repeatOf) {
		const before = norm(context.lastAgent);
		if (turn.acted) return fail("担当を呼んだ");
		if (!before) return fail("前の答えなし");
		return commonRun(before, norm(turn.said)) >= 8
			? ok
			: fail("前の答えと違う");
	}
	if (!step.expect) return turn.acted ? fail("雑談で担当を呼んだ") : ok;
	const { delegated } = turn;
	if (!delegated)
		return fail(turn.acted ? "探したが頼まなかった" : "呼ばずに返事");
	if (delegated.toolchain !== step.expect.toolchain)
		return fail(`担当違い ${delegated.toolchain}`);
	if (!step.expect.has.test(delegated.request)) return fail("依頼の中身違い");
	if (step.expect.not?.test(delegated.request))
		return fail("前の依頼が混ざった");
	return ok;
}

/** What one step cost: the calls of its turn, timed. Times are milliseconds from the step's start. */
export type Timing = {
	/** When the user first hears words: the first reply text, or the end of the hand-over call. */
	heardMs: number | null;
	turnMs: number;
	calls: number;
	model: string | null;
	reasoningChars: number;
	/** The first call's first token and first text. */
	firstTokenMs: number | null;
	firstTextMs: number | null;
	tokensPerSecond: number | null;
	outputTokens: number;
	/** The first call's prompt tokens and how many of them were cached (null when the server does not say). */
	promptTokens: number | null;
	cachedPromptTokens: number | null;
	/** The output limit the server was asked for (null when the path does not send one). */
	requestedLimit: number | null;
	/** A call ended at its output limit. */
	truncated: boolean;
};

const mean = (xs: readonly number[]) =>
	xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

export function timingOf(
	metrics: readonly CallMetrics[],
	turnStartedAt: number,
	turnMs: number,
	delegated: boolean,
): Timing {
	const heard = [
		...metrics.flatMap((m) =>
			m.firstContentMs === null
				? []
				: [m.startedAt + m.firstContentMs - turnStartedAt],
		),
		...(delegated && metrics.length
			? [metrics.at(-1)!.startedAt + metrics.at(-1)!.totalMs - turnStartedAt]
			: []),
	];
	const first = metrics[0];
	return {
		heardMs: heard.length ? Math.min(...heard) : null,
		turnMs,
		calls: metrics.length,
		model: first?.model ?? null,
		reasoningChars: metrics.reduce((sum, m) => sum + m.reasoningChars, 0),
		firstTokenMs: first?.firstTokenMs ?? null,
		firstTextMs: first?.firstTextMs ?? null,
		tokensPerSecond: mean(
			metrics.flatMap((m) =>
				m.tokensPerSecond === null ? [] : [m.tokensPerSecond],
			),
		),
		outputTokens: metrics.reduce((sum, m) => sum + m.outputTokens, 0),
		promptTokens: first?.promptTokens ?? null,
		cachedPromptTokens: first?.cachedPromptTokens ?? null,
		requestedLimit: first?.requestedLimit ?? null,
		truncated: metrics.some((m) => m.finishReason === "length"),
	};
}

/** One measured step. */
export type StepRecord = Timing & {
	chain: string;
	form: string;
	rep: number;
	index: number;
	say: string;
	/** Free steps only set the talk up; they are not counted. */
	scored: boolean;
	pass: boolean;
	why: string;
	toolchain?: string;
	request?: string;
	said: string;
};

export type Cell = {
	passed: number;
	total: number;
	heardMs: number | null;
	turnMs: number | null;
	reasoningChars: number | null;
	tokensPerSecond: number | null;
	/** Cached share of the first calls' prompt tokens (null when no call said). */
	cachedShare: number | null;
	truncated: number;
	fails: string[];
};

export function cellOf(records: readonly StepRecord[]): Cell {
	const scored = records.filter((r) => r.scored);
	const nums = (pick: (r: StepRecord) => number | null) =>
		mean(scored.flatMap((r) => pick(r) ?? []));
	const prompted = scored.filter(
		(r) => r.promptTokens && r.cachedPromptTokens !== null,
	);
	const prompt = prompted.reduce((s, r) => s + r.promptTokens!, 0);
	return {
		passed: scored.filter((r) => r.pass).length,
		total: scored.length,
		heardMs: nums((r) => r.heardMs),
		turnMs: nums((r) => r.turnMs),
		reasoningChars: nums((r) => r.reasoningChars),
		tokensPerSecond: nums((r) => r.tokensPerSecond),
		cachedShare: prompt
			? prompted.reduce((s, r) => s + r.cachedPromptTokens!, 0) / prompt
			: null,
		truncated: scored.filter((r) => r.truncated).length,
		fails: scored
			.filter((r) => !r.pass)
			.map(
				(r) => `${r.chain} / ${r.form} / 回${r.rep + 1} / ${r.say}: ${r.why}`,
			),
	};
}

export type ReportMeta = {
	startedAt: string;
	client: string;
	harness: string;
	reasoning: string;
	/** The output limit the harness sets (before the profile's own reserve caps it). */
	outputLimit: number;
	reps: number;
	probe: boolean;
	chains: readonly string[];
	forms: readonly string[];
	/** Digest of the saved LARM settings (null for another client). */
	settings: string | null;
};

const seconds = (ms: number | null) =>
	ms === null ? "-" : (ms / 1000).toFixed(1);
const whole = (n: number | null) => (n === null ? "-" : String(Math.round(n)));
const share = (n: number | null) =>
	n === null ? "-" : `${Math.round(n * 100)}%`;
const score = (cell: Cell) =>
	cell.total ? `${cell.passed}/${cell.total}` : "-";
const distinct = (xs: readonly (string | number | null)[]) =>
	[...new Set(xs.filter((x): x is string | number => x !== null))].join(", ") ||
	"-";

/** The results as Markdown: chain x form scores, timings per form, and the failures. */
export function reportMarkdown(
	meta: ReportMeta,
	records: readonly StepRecord[],
): string {
	const where = (chain: string | null, form: string) =>
		cellOf(
			records.filter(
				(r) => r.form === form && (chain === null || r.chain === chain),
			),
		);
	const head = (cols: readonly string[]) =>
		`| ${cols.join(" | ")} |\n| ${cols.map(() => "---").join(" | ")} |`;
	const lines = [
		`# 会話ハーネスの測定 ${meta.startedAt}`,
		"",
		"| 項目 | 値 |",
		"| --- | --- |",
		`| 経路 | ${meta.client} |`,
		`| ハーネス | ${meta.harness} |`,
		`| reasoning | ${meta.reasoning} |`,
		`| 出力の上限（ハーネス / 実際に求めた値） | ${meta.outputLimit} / ${distinct(records.map((r) => r.requestedLimit))} |`,
		`| 回数 | ${meta.reps}${meta.probe ? "（probe）" : ""} |`,
		`| サーバーが返したモデル名 | ${distinct(records.map((r) => r.model))} |`,
		`| 設定の digest | ${meta.settings ?? "-"} |`,
		"",
		"## 合否（連続依頼 × 形）",
		"",
		head(["連続依頼", ...meta.forms]),
		...meta.chains.map(
			(chain) =>
				`| ${chain} | ${meta.forms.map((form) => score(where(chain, form))).join(" | ")} |`,
		),
		`| 合計 | ${meta.forms.map((form) => score(where(null, form))).join(" | ")} |`,
		"",
		"## 時間と token（形ごとの平均）",
		"",
		head([
			"連続依頼",
			"形",
			"聞こえるまで(秒)",
			"1手(秒)",
			"推論(字)",
			"tok/s",
			"cache",
			"上限で途切れ",
		]),
		...meta.chains.flatMap((chain) =>
			meta.forms.map((form) => {
				const c = where(chain, form);
				return `| ${chain} | ${form} | ${seconds(c.heardMs)} | ${seconds(c.turnMs)} | ${whole(c.reasoningChars)} | ${whole(c.tokensPerSecond)} | ${share(c.cachedShare)} | ${c.truncated} |`;
			}),
		),
		...meta.forms.map((form) => {
			const c = where(null, form);
			return `| 合計 | ${form} | ${seconds(c.heardMs)} | ${seconds(c.turnMs)} | ${whole(c.reasoningChars)} | ${whole(c.tokensPerSecond)} | ${share(c.cachedShare)} | ${c.truncated} |`;
		}),
		"",
		"## 落ちた手",
		"",
		...(cellOf(records).fails.length
			? cellOf(records).fails.map((f) => `- ${f}`)
			: ["なし"]),
		"",
	];
	return lines.join("\n");
}
