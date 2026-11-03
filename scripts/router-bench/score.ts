/**
 * Router bench scoring (spec toolchain-router-redesign 2026-11-01 §7). No network, no product DB:
 *   bun scripts/router-bench/score.ts --items <items.jsonl> --predictions <predictions.jsonl> --out <new dir>
 *     [--split test|dev|...|any] [--settings <thresholds.json>] [--catalog <catalog.json>]
 * `items` are the evaluation set (§7.1), `predictions` what LARM's router answered for them
 * (`{ id, probabilities, scores?, durationMs, revision }`). Each prediction goes through the product's decision table
 * (`decide`), so the numbers are those of the host's decision, not of the model alone. Only reviewed items count.
 * An item with no prediction is an error, listed by count, never dropped.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { routerSettingsSchema } from "../../api/domains/settings/contracts";
import {
	CONVERSATION_ID,
	MEMORY_ID,
	decide,
	type Ranked,
	type RouteCandidate,
	type RouterSettings,
} from "../../api/domains/dialogue/service/routed-route";

export type Item = {
	id: string;
	split: string | null;
	gold: { primary: string; acceptable: string[] };
	review: { status: string } | null;
};
export type Prediction = {
	id: string;
	probabilities: Record<string, number>;
	scores?: Record<string, number> | null;
	durationMs?: number;
	revision?: string;
};
/** What the bench knows of a toolchain the item files do not carry: only the decision table's inputs. */
export type CatalogEntry = {
	read?: boolean;
	general?: boolean;
	execution?: string;
	minImpact?: string;
};

export const ASK = "ask";
const THRESHOLDS = ["accept", "low", "margin", "approve", "multi"] as const;
type Thresholds = Pick<RouterSettings, (typeof THRESHOLDS)[number]>;

/** The generic id the item files use for a candidate id the product sends (`t3.check`, `c1.approve`, ...). */
export function genericId(id: string): string {
	let match = /^t\d+\.(check|amend|cancel)$/.exec(id);
	if (match) return `work.${match[1]}`;
	match = /^t\d+\.redirect:(.+)$/.exec(id);
	if (match) return `redirect:${match[1]}`;
	match = /^c\d+\.(approve|decline)$/.exec(id);
	if (match) return `pending.${match[1]}`;
	if (/^t\d+\.answer$/.test(id)) return "pending.answer";
	if (id === "switch.discard") return "pending.approve";
	return id;
}

/** The product's candidate for a prediction's id, with the little the decision table reads of it. */
function candidateOf(
	id: string,
	catalog: Record<string, CatalogEntry>,
): RouteCandidate {
	const base = { id, passage: "" };
	if (id === CONVERSATION_ID) return { ...base, kind: "conversation" };
	if (id === MEMORY_ID) return { ...base, kind: "memory" };
	let match = /^(t\d+)\.(check|amend|cancel)$/.exec(id);
	if (match)
		return {
			...base,
			kind: "work",
			todo: match[1]!,
			operation: match[2] as "check" | "amend" | "cancel",
			title: "",
		};
	match = /^(t\d+)\.redirect:(.+)$/.exec(id);
	if (match)
		return {
			...base,
			kind: "redirect",
			todo: match[1]!,
			title: "",
			toolchainId: match[2]!,
			target: "",
		};
	match = /^(c\d+)\.(approve|decline)$/.exec(id);
	if (match)
		return {
			...base,
			kind: "pending",
			operation: match[2] as "approve" | "decline",
			confirmation: match[1]!,
			toolchain: "",
		};
	match = /^(t\d+)\.answer$/.exec(id);
	if (match)
		return {
			...base,
			kind: "pending",
			operation: "answer",
			todo: match[1]!,
			title: "",
		};
	if (id === "switch.discard")
		return {
			...base,
			kind: "pending",
			operation: "discard",
			toolchain: "",
			title: "",
		};
	const entry = catalog[id] ?? {};
	const card = {
		id,
		title: id,
		...(entry.general ? { general: true } : {}),
		...(entry.execution ? { execution: entry.execution } : {}),
		...(entry.minImpact ? { minImpact: entry.minImpact } : {}),
		score: { rank: 1, ftsRank: null, similarity: null, fromHistory: false },
	};
	return {
		...base,
		kind: entry.read ? "read" : "toolchain",
		card,
		choice: { id, title: id },
	} as unknown as RouteCandidate;
}

/** The probabilities (or scores) by generic id: candidates that map to one id add up (scores keep the largest). */
function byGeneric(
	values: Record<string, number>,
	combine: "sum" | "max",
): Map<string, number> {
	const out = new Map<string, number>();
	for (const [id, value] of Object.entries(values)) {
		const key = genericId(id);
		const had = out.get(key);
		out.set(
			key,
			had === undefined
				? value
				: combine === "sum"
					? had + value
					: Math.max(had, value),
		);
	}
	return out;
}

/** What the host decides on a prediction, as a generic id; `again` is the host asking before it acts. */
export function decisionOf(
	prediction: Prediction,
	thresholds: Thresholds,
	catalog: Record<string, CatalogEntry> = {},
): { row: number; id: string; asked: boolean } {
	const ranked: Ranked[] = Object.entries(prediction.probabilities)
		.map(([id, p]) => ({
			candidate: candidateOf(id, catalog),
			raw: p,
			correction: 0,
			p,
			score: prediction.scores?.[id] ?? null,
		}))
		.sort((a, b) => b.p - a.p);
	const decision = decide(ranked, thresholds);
	if (decision.to === "conversation")
		return { row: decision.row, id: CONVERSATION_ID, asked: false };
	if (decision.to === "ask") return { row: decision.row, id: ASK, asked: true };
	return {
		row: decision.row,
		id: genericId(decision.candidate.id),
		asked: decision.to === "again",
	};
}

const rate = (hits: number, of: number) => (of ? hits / of : null);
/** Nearest-rank percentile of a list (sorted here). */
function percentile(values: number[], q: number): number | null {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;
}

export type Summary = ReturnType<typeof score>;

/** The measures of reviewed `items` of the split against `predictions`; throws when a counted item has none. */
export function score(input: {
	items: readonly Item[];
	predictions: readonly Prediction[];
	split: string;
	thresholds: Thresholds;
	catalog?: Record<string, CatalogEntry>;
}) {
	const { thresholds, catalog = {} } = input;
	const inSplit = input.items.filter((item) =>
		input.split === "any" ? true : item.split === input.split,
	);
	const reviewed = inSplit.filter((item) => item.review?.status === "reviewed");
	const predicted = new Map(input.predictions.map((p) => [p.id, p]));
	const missing = reviewed.filter((item) => !predicted.has(item.id));
	if (missing.length)
		throw new MissingPredictions(missing.map((item) => item.id));
	const counted = new Set(reviewed.map((item) => item.id));
	const rows: Record<string, number> = {};
	const goldHits = (item: Item, id: string) =>
		id === item.gold.primary || item.gold.acceptable.includes(id);
	let top1 = 0;
	const recallAt = { 1: 0, 3: 0, 5: 0 };
	let decisionRight = 0;
	let reAsks = 0;
	let rowEightAsks = 0;
	let needlessAsks = 0;
	let conversationGold = 0;
	let falseDispatch = 0;
	let dispatchGold = 0;
	let missed = 0;
	const perGold = new Map<string, { n: number; hits: number }>();
	const latency: number[] = [];
	for (const item of reviewed) {
		const prediction = predicted.get(item.id)!;
		const order = [...byGeneric(prediction.probabilities, "sum")].sort(
			(a, b) => b[1] - a[1],
		);
		const ids = order.map(([id]) => id);
		const hit = (k: number) => ids.slice(0, k).some((id) => goldHits(item, id));
		if (hit(1)) top1++;
		for (const k of [1, 3, 5] as const) if (hit(k)) recallAt[k]++;
		const decided = decisionOf(prediction, thresholds, catalog);
		rows[`row${decided.row}`] = (rows[`row${decided.row}`] ?? 0) + 1;
		// A question back in row 8 (the user chooses) and the host asking once more before it acts (rows 5 and 6) differ.
		const reAsked = decided.asked && decided.id !== ASK;
		if (reAsked) reAsks++;
		if (decided.id === ASK) {
			rowEightAsks++;
			// A needless question: the router's own first choice was the gold.
			if (hit(1)) needlessAsks++;
		}
		// A question asked once more decided nothing yet: it is neither right nor wrong.
		if (!reAsked && goldHits(item, decided.id)) decisionRight++;
		if (item.gold.primary === CONVERSATION_ID) {
			conversationGold++;
			if (decided.id !== CONVERSATION_ID) falseDispatch++;
		} else {
			dispatchGold++;
			if (decided.id === CONVERSATION_ID) missed++;
		}
		const gold = perGold.get(item.gold.primary) ?? { n: 0, hits: 0 };
		gold.n++;
		if (hit(1)) gold.hits++;
		perGold.set(item.gold.primary, gold);
		if (typeof prediction.durationMs === "number")
			latency.push(prediction.durationMs);
	}
	const n = reviewed.length;
	const recalls = [...perGold].map(([id, { n: count, hits }]) => ({
		id,
		n: count,
		recall: hits / count,
	}));
	recalls.sort((a, b) => a.recall - b.recall || a.id.localeCompare(b.id));
	return {
		split: input.split,
		thresholds,
		n,
		itemsInSplit: inSplit.length,
		skippedUnreviewed: inSplit.length - n,
		unusedPredictions: input.predictions.filter((p) => !counted.has(p.id))
			.length,
		top1: rate(top1, n),
		recallAt1: rate(recallAt[1], n),
		recallAt3: rate(recallAt[3], n),
		recallAt5: rate(recallAt[5], n),
		decisionAccuracy: rate(decisionRight, n - reAsks),
		reAsks,
		falseDispatchRate: {
			rate: rate(falseDispatch, conversationGold),
			of: conversationGold,
		},
		missRate: { rate: rate(missed, dispatchGold), of: dispatchGold },
		askRate: rate(rowEightAsks, n),
		reconfirmRate: rate(reAsks, n),
		needlessAskRate: {
			rate: rate(needlessAsks, rowEightAsks),
			of: rowEightAsks,
		},
		perGoldRecall: { minimum: recalls[0] ?? null, byId: recalls },
		latencyMs: {
			n: latency.length,
			p50: percentile(latency, 0.5),
			p95: percentile(latency, 0.95),
		},
		rows,
	};
}

/** Items that have no prediction: the run stops and says how many, and which. */
export class MissingPredictions extends Error {
	constructor(readonly ids: string[]) {
		super(`predictions_missing: ${ids.length}`);
	}
}

const percent = (value: number | null) =>
	value === null ? "なし" : `${(value * 100).toFixed(1)}%`;
const ms = (value: number | null) =>
	value === null ? "なし" : `${Math.round(value)} ms`;

/** The report, in Japanese: the numbers and what each one counts. */
export function reportOf(summary: Summary): string {
	const t = summary.thresholds;
	const lines = [
		"# Router 採点結果",
		"",
		`対象: split \`${summary.split}\`、レビュー済み ${summary.n} 件（split 内 ${summary.itemsInSplit} 件、未レビュー ${summary.skippedUnreviewed} 件は数えない。使われなかった予測 ${summary.unusedPredictions} 件）。`,
		`しきい値: accept ${t.accept} / low ${t.low} / margin ${t.margin} / approve ${t.approve} / multi ${t.multi}。決定は製品の決定表（\`decide\`）で出した。`,
		"",
		"## 精度",
		"",
		"| 指標 | 値 | 数え方 |",
		"| --- | --- | --- |",
		`| Top-1（argmax） | ${percent(summary.top1)} | 確率の最大の候補が primary か acceptable |`,
		`| Recall@1 / @3 / @5 | ${percent(summary.recallAt1)} / ${percent(summary.recallAt3)} / ${percent(summary.recallAt5)} | 上位 K 件に primary か acceptable が入る |`,
		`| 決定の正解率 | ${percent(summary.decisionAccuracy)}（母数 ${summary.n - summary.reAsks}） | 決定表の結果が primary か acceptable。聞き返し（行 8）は正解が \`ask\` のときだけ正しい。会話の回に落ちた行 8 は会話として数える。確認の聞き直し ${summary.reAsks} 件は、まだ何も決めていないので分子にも母数にも入れない |`,
		`| 誤起動率（False Dispatch） | ${percent(summary.falseDispatchRate.rate)}（母数 ${summary.falseDispatchRate.of}） | 正解が会話の発言を、会話以外にした割合（確認の聞き返しも含む） |`,
		`| 見逃し率 | ${percent(summary.missRate.rate)}（母数 ${summary.missRate.of}） | 正解が会話以外の発言を、会話の回にした割合 |`,
		`| 聞き返しの率（行 8） | ${percent(summary.askRate)} | 二つの担当のどちらかをホストが尋ねた割合 |`,
		`| 確認の聞き直しの率（行 5・6） | ${percent(summary.reconfirmRate)} | 承認や取消を、しきい値に届かずもう一度尋ねた割合 |`,
		`| 不要な聞き返しの率 | ${percent(summary.needlessAskRate.rate)}（母数 ${summary.needlessAskRate.of}） | 聞き返した行 8 のうち、Router の 1 位が正解だった割合 |`,
		"",
		"## 正解 id ごとの Top-1",
		"",
		summary.perGoldRecall.minimum
			? `最小は \`${summary.perGoldRecall.minimum.id}\` の ${percent(summary.perGoldRecall.minimum.recall)}（${summary.perGoldRecall.minimum.n} 件）。`
			: "対象がありません。",
		"",
		"| 正解 id | 件数 | Top-1 |",
		"| --- | --- | --- |",
		...summary.perGoldRecall.byId.map(
			(g) => `| ${g.id} | ${g.n} | ${percent(g.recall)} |`,
		),
		"",
		"## 時間",
		"",
		`Router の往復（n=${summary.latencyMs.n}）: P50 ${ms(summary.latencyMs.p50)} / P95 ${ms(summary.latencyMs.p95)}`,
		"",
		"## 決定表の行ごとの件数",
		"",
		"| 行 | 件数 |",
		"| --- | --- |",
		...Object.entries(summary.rows)
			.sort(([a], [b]) => Number(a.slice(3)) - Number(b.slice(3)))
			.map(([row, count]) => `| ${row.slice(3)} | ${count} |`),
		"",
	];
	return lines.join("\n");
}

function readJsonl<T>(path: string): T[] {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line, i) => {
			try {
				return JSON.parse(line) as T;
			} catch {
				throw new Error(`jsonl_invalid: ${path}:${i + 1}`);
			}
		});
}

/** Items with their defaults: no acceptable ids, no review. */
function itemOf(raw: Record<string, unknown>): Item {
	const gold = raw.gold as
		{ primary?: unknown; acceptable?: unknown } | undefined;
	if (typeof raw.id !== "string" || typeof gold?.primary !== "string")
		throw new Error(`item_invalid: ${String(raw.id)}`);
	return {
		id: raw.id,
		split: typeof raw.split === "string" ? raw.split : null,
		gold: {
			primary: gold.primary,
			acceptable: Array.isArray(gold.acceptable)
				? gold.acceptable.filter((a): a is string => typeof a === "string")
				: [],
		},
		review:
			raw.review &&
			typeof (raw.review as { status?: unknown }).status === "string"
				? { status: (raw.review as { status: string }).status }
				: null,
	};
}

export function main(argv: string[]) {
	const { values } = parseArgs({
		args: argv,
		options: {
			items: { type: "string" },
			predictions: { type: "string" },
			split: { type: "string", default: "test" },
			settings: { type: "string" },
			catalog: { type: "string" },
			out: { type: "string" },
		},
	});
	if (!values.items || !values.predictions || !values.out)
		throw new Error(
			"usage: --items <jsonl> --predictions <jsonl> --out <new dir>",
		);
	if (existsSync(values.out)) throw new Error(`out_exists: ${values.out}`);
	const overrides = values.settings
		? (JSON.parse(readFileSync(values.settings, "utf8")) as object)
		: {};
	const settings = routerSettingsSchema.parse(overrides);
	const thresholds = Object.fromEntries(
		THRESHOLDS.map((key) => [key, settings[key]]),
	) as Thresholds;
	const summary = score({
		items: readJsonl<Record<string, unknown>>(values.items).map(itemOf),
		predictions: readJsonl<Prediction>(values.predictions),
		split: values.split ?? "test",
		thresholds,
		...(values.catalog
			? {
					catalog: JSON.parse(readFileSync(values.catalog, "utf8")) as Record<
						string,
						CatalogEntry
					>,
				}
			: {}),
	});
	mkdirSync(values.out, { recursive: true });
	writeFileSync(
		join(values.out, "summary.json"),
		`${JSON.stringify(summary, null, 2)}\n`,
	);
	writeFileSync(join(values.out, "report.md"), reportOf(summary));
	console.log(`router-bench: n=${summary.n} -> ${values.out}`);
}

if (import.meta.main) {
	try {
		main(process.argv.slice(2));
	} catch (error) {
		if (error instanceof MissingPredictions) {
			console.error(
				`router-bench: 予測がない項目が ${error.ids.length} 件あります（例: ${error.ids.slice(0, 10).join(", ")}）。採点しません。`,
			);
		} else {
			console.error(
				`router-bench: ${error instanceof Error ? error.message : "failed"}`,
			);
		}
		process.exit(1);
	}
}
