/**
 * Judging, timing and aggregation of the harness measurement (the conversation harness design, section 5.1): whether
 * a turn passed its step and why not, what the user waited for, and the chain x form table. Pure functions.
 */
import type { TaggedCall } from "./harness-client";
import { detailLines, type CallDetail } from "./harness-detail";
import type { Step } from "./harness-chains";

export type Turn = {
	/** The words the user hears: the reply, or the announcement of a hand-over. */
	said: string;
	/** The turn searched or handed over (a refused call counts). */
	acted: boolean;
	delegated?: { toolchain: string; request: string };
	error?: string;
	/**
	 * The check a local answer failed when nothing answered in its place (no cloud fallback): the turn has no answer
	 * and fails with that check.
	 */
	localFailure?: string;
};

export type TurnMode = "single" | "decide-then-reply";

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
	if (turn.localFailure) return fail(`fallback:${turn.localFailure}`);
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
	/** The first decision call (decide-then-reply): its first token, first text, and the decision calls' total time. */
	decisionFirstTokenMs: number | null;
	decisionFirstTextMs: number | null;
	decisionMs: number | null;
	/** The same for the reply calls. */
	replyFirstTokenMs: number | null;
	replyFirstTextMs: number | null;
	replyMs: number | null;
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

/**
 * The timing of a turn's calls. The user first hears words at the first text of a single or cloud call; a decision
 * is never spoken, and a local reply is heard when its head passed the checks (`publishedAt`, a performance.now()
 * time), or at its end when the whole reply was awaited.
 */
export function timingOf(
	calls: readonly TaggedCall[],
	turnStartedAt: number,
	turnMs: number,
	delegated: boolean,
	publishedAt: number | null = null,
): Timing {
	const metrics = calls.map((c) => c.metrics);
	const last = metrics.at(-1);
	const heard = [
		...calls.flatMap(({ kind, metrics: m }) =>
			(kind === "single" || kind === "cloud") && m.firstContentMs !== null
				? [m.startedAt + m.firstContentMs - turnStartedAt]
				: [],
		),
		...(publishedAt === null ? [] : [publishedAt - turnStartedAt]),
		...(delegated && last
			? [last.startedAt + last.totalMs - turnStartedAt]
			: []),
	];
	const first = metrics[0];
	const ofKind = (kind: TaggedCall["kind"]) =>
		calls.filter((c) => c.kind === kind).map((c) => c.metrics);
	const phase = (kind: TaggedCall["kind"]) => {
		const list = ofKind(kind);
		return {
			firstToken: list[0]?.firstTokenMs ?? null,
			firstText: list[0]?.firstTextMs ?? null,
			total: list.length ? list.reduce((sum, m) => sum + m.totalMs, 0) : null,
		};
	};
	const decision = phase("decision");
	const reply = phase("reply");
	return {
		heardMs: heard.length ? Math.min(...heard) : null,
		turnMs,
		calls: metrics.length,
		model: first?.model ?? null,
		reasoningChars: metrics.reduce((sum, m) => sum + m.reasoningChars, 0),
		firstTokenMs: first?.firstTokenMs ?? null,
		firstTextMs: first?.firstTextMs ?? null,
		decisionFirstTokenMs: decision.firstToken,
		decisionFirstTextMs: decision.firstText,
		decisionMs: decision.total,
		replyFirstTokenMs: reply.firstToken,
		replyFirstTextMs: reply.firstText,
		replyMs: reply.total,
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

/** The reply that copies the agent's previous reply: the longest shared run (spaces left out), null without both. */
export function copyRunOf(said: string, previous: string): number | null {
	const a = norm(said);
	const b = norm(previous);
	return a && b ? commonRun(a, b) : null;
}

/** A shared run this long is a copy of the previous reply (the local turn's own bound). */
export const COPY_RUN = 20;

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
	turnMode: TurnMode;
	/** The first check a local answer failed in this step (decide-then-reply), null for none. */
	failedCheck: string | null;
	failedChecks: string[];
	/** The cloud answered a round the local answer failed. */
	cloudAnswered: boolean;
	/** The longest run the reply shares with the agent's previous reply. */
	copyRun: number | null;
	/** Why the turn ended. */
	stop: string;
	/** What each model call did: its tool calls with the host's verdicts, texts, finish reason and error. */
	callDetails: CallDetail[];
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
	/** Share of decide-then-reply steps with a failed check (null when no step used that turn). */
	fallbackShare: number | null;
	cloudAnswered: number;
	/** Share of replies (all steps) whose run with the previous reply is `COPY_RUN` or more (null when none measured). */
	copyShare: number | null;
	fails: string[];
};

export function cellOf(records: readonly StepRecord[]): Cell {
	const scored = records.filter((r) => r.scored);
	const nums = (pick: (r: StepRecord) => number | null) =>
		mean(scored.flatMap((r) => pick(r) ?? []));
	const prompted = scored.filter(
		(r) => r.promptTokens && r.cachedPromptTokens !== null,
	);
	const decided = records.filter((r) => r.turnMode === "decide-then-reply");
	const measured = records.filter((r) => r.copyRun !== null);
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
		fallbackShare: decided.length
			? decided.filter((r) => r.failedCheck !== null).length / decided.length
			: null,
		cloudAnswered: records.filter((r) => r.cloudAnswered).length,
		copyShare: measured.length
			? measured.filter((r) => r.copyRun! >= COPY_RUN).length / measured.length
			: null,
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
	turn: TurnMode;
	/** "なし", or the path that answers a round the local answer failed. */
	fallback: string;
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
		`| ターン | ${meta.turn} |`,
		`| 失敗した回のやり直し | ${meta.fallback} |`,
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
			"fallback率",
			"cloud回答",
			`前の返事の写し(${COPY_RUN}字以上)`,
		]),
		...meta.chains.flatMap((chain) =>
			meta.forms.map((form) => {
				const c = where(chain, form);
				return `| ${chain} | ${form} | ${seconds(c.heardMs)} | ${seconds(c.turnMs)} | ${whole(c.reasoningChars)} | ${whole(c.tokensPerSecond)} | ${share(c.cachedShare)} | ${c.truncated} | ${share(c.fallbackShare)} | ${c.cloudAnswered} | ${share(c.copyShare)} |`;
			}),
		),
		...meta.forms.map((form) => {
			const c = where(null, form);
			return `| 合計 | ${form} | ${seconds(c.heardMs)} | ${seconds(c.turnMs)} | ${whole(c.reasoningChars)} | ${whole(c.tokensPerSecond)} | ${share(c.cachedShare)} | ${c.truncated} | ${share(c.fallbackShare)} | ${c.cloudAnswered} | ${share(c.copyShare)} |`;
		}),
		...(records.some((r) => r.turnMode === "decide-then-reply")
			? [
					"",
					"## 判断と返事の時間（decide-then-reply、平均 ms）",
					"",
					head([
						"形",
						"判断 初token",
						"判断 初text",
						"判断 計",
						"返事 初token",
						"返事 初text",
						"返事 計",
					]),
					...meta.forms.map((form) => {
						const rows = records.filter(
							(r) => r.form === form && r.turnMode === "decide-then-reply",
						);
						const avg = (pick: (r: StepRecord) => number | null) =>
							whole(mean(rows.flatMap((r) => pick(r) ?? [])));
						return `| ${form} | ${avg((r) => r.decisionFirstTokenMs)} | ${avg((r) => r.decisionFirstTextMs)} | ${avg((r) => r.decisionMs)} | ${avg((r) => r.replyFirstTokenMs)} | ${avg((r) => r.replyFirstTextMs)} | ${avg((r) => r.replyMs)} |`;
					}),
					"",
					"## 落ちた確認（回数）",
					"",
					...checkCounts(records),
				]
			: []),
		"",
		"## 落ちた手",
		"",
		...(cellOf(records).fails.length
			? cellOf(records).fails.map((f) => `- ${f}`)
			: ["なし"]),
		"",
		"## 落ちた手の詳細",
		"",
		...failureDetails(records),
		"",
	];
	return lines.join("\n");
}

/** How often each check failed, as list lines (or "なし"). */
export function checkCounts(records: readonly StepRecord[]): string[] {
	const counts = new Map<string, number>();
	for (const r of records)
		for (const check of r.failedChecks)
			counts.set(check, (counts.get(check) ?? 0) + 1);
	return counts.size
		? [...counts].map(([check, n]) => `- ${check}: ${n}`)
		: ["なし"];
}

/** The failed steps with their model calls in order: tool name, verdict and the reason for a refusal. */
export function failureDetails(records: readonly StepRecord[]): string[] {
	const failed = records.filter((r) => r.scored && !r.pass);
	if (!failed.length) return ["なし"];
	return failed.flatMap((r) => [
		`- ${r.chain} / ${r.form} / 回${r.rep + 1} / ${r.say}: ${r.why}（終わり方: ${r.stop}、モデルの呼出し ${r.callDetails.length} 回）`,
		...r.callDetails.flatMap((detail, i) => detailLines(detail, i + 1)),
	]);
}
