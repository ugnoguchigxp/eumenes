import { homedir } from "node:os";
import { jstDay, jstDisplay } from "../../../infrastructure/jst-time";
import {
	LOG_SEVERITY,
	readLogEntries,
	type LogEntry,
} from "../../../infrastructure/log-reader";
import { unitSlots, type StewardActivity, type UnitSlot } from "../contracts";
import {
	countFailedUnits,
	lastClosedUnits,
	openUnitJobs,
	type ClosedUnitRow,
} from "../repository";
import type { StewardDeps } from "./types";

/** The whole report stays within this many characters, like the run's error report. */
export const STEWARD_REPORT_LIMIT = 3000;
/** A step that gave LARM to the conversation: the steward tries again by itself, so it is not a failure to show. */
const YIELD_CODES = ["larm_preempted"] as const;
const LOG_LINES = 6;

const SLOT_LABELS: Record<UnitSlot, string> = {
	reflect: "記憶の反映",
	world: "世界の記録",
	maintenance: "記憶の整理",
	episode: "会話の要約",
};

const bySlot = (a: UnitSlot, b: UnitSlot) =>
	unitSlots.indexOf(a) - unitSlots.indexOf(b);

/**
 * Per slot, the last closed unit (yields passed over) when it failed. A failure whose decision was pruned has no
 * code left and still shows, as `unknown`.
 */
function failedUnits(rows: ClosedUnitRow[]) {
	return rows
		.filter((row) => row.state === "failed")
		.map((row) => ({ ...row, code: row.errorCode ?? "unknown" }))
		.sort((a, b) => bySlot(a.slot, b.slot));
}

const SAFE_VALUE = /^[\w.@:+[\]/-]{1,100}$/;
function safe(value: unknown): string | undefined {
	if (typeof value === "number")
		return Number.isFinite(value) ? String(value) : undefined;
	return typeof value === "string" && SAFE_VALUE.test(value)
		? value
		: undefined;
}

/** The first frame of a record, relative to the working directory and never showing the home directory. */
function frame(entry: LogEntry): string | undefined {
	if (!Array.isArray(entry.errorFrames)) return undefined;
	const first = entry.errorFrames.find(
		(f): f is string => typeof f === "string" && f.length <= 200,
	);
	if (!first) return undefined;
	const root = process.cwd().replace(/\/$/, "") + "/";
	const home = homedir().replace(/\/$/, "");
	if (first.startsWith(root)) return first.slice(root.length);
	if (home && first.startsWith(`${home}/`))
		return `~/${first.slice(home.length + 1)}`;
	return first;
}

const LEVEL_LABELS: Record<string, string> = {
	warn: "WARN",
	error: "ERROR",
	fatal: "FATAL",
};

function logLines(entries: LogEntry[]): string[] {
	const lines: string[] = [];
	for (const entry of entries
		.filter((e) => (LOG_SEVERITY[String(e.level)] ?? 0) >= LOG_SEVERITY.warn!)
		.slice(-LOG_LINES)) {
		const time = String(entry.time ?? "").slice(11, 19);
		const parts = [
			`${time} ${LEVEL_LABELS[String(entry.level)] ?? "?"} ${safe(entry.component) ?? "?"} ${safe(entry.event) ?? "?"}`,
			safe(entry.stepId) ? `stepId: ${safe(entry.stepId)}` : undefined,
			safe(entry.reason) ? `reason: ${safe(entry.reason)}` : undefined,
			safe(entry.source) ? `source: ${safe(entry.source)}` : undefined,
		].filter(Boolean);
		lines.push(`  - ${parts.join("  ")}`);
		const where = frame(entry);
		if (where) lines.push(`    場所: ${where}`);
	}
	return lines;
}

/** The start of the current Asia/Tokyo day, as the ISO instant units record their close in. */
const jstDayStart = (ms: number) =>
	new Date(Date.parse(`${jstDay(ms)}T00:00:00+09:00`)).toISOString();

/**
 * The steward's activity in a conversation (spec/memory-activity-indicator-design-2026-10-25.md): what runs now,
 * what failed last, and the diagnostic text of those failures (IDs and fixed codes only).
 */
export function createActivity(
	deps: Pick<StewardDeps, "store" | "queue" | "nowMs" | "logFile">,
) {
	function activity(conversationId: string): StewardActivity {
		return deps.store.read((db) => {
			const slots = new Set<UnitSlot>();
			for (const unit of openUnitJobs(db, conversationId))
				if (deps.queue.getInTransaction(db, unit.jobId)?.state === "running")
					slots.add(unit.slot);
			return {
				running: slots.size > 0,
				slots: [...slots].sort(bySlot),
				errors: failedUnits(
					lastClosedUnits(db, conversationId, YIELD_CODES),
				).map((row) => ({
					slot: row.slot,
					step: row.step,
					code: row.code,
					at: row.closedAt,
				})),
			};
		});
	}

	async function errorReport(conversationId: string): Promise<string | null> {
		const now = deps.nowMs();
		const since = jstDayStart(now);
		const failed = deps.store.read((db) =>
			failedUnits(lastClosedUnits(db, conversationId, YIELD_CODES)).map(
				(row) => ({
					...row,
					today: countFailedUnits(
						db,
						conversationId,
						row.step,
						since,
						YIELD_CODES,
					),
				}),
			),
		);
		if (failed.length === 0) return null;
		const file = deps.logFile?.();
		const sections: string[][] = [];
		for (const row of failed) {
			let entries: LogEntry[] = [];
			if (file && row.jobId) {
				try {
					entries = await readLogEntries(file, [row.jobId]);
				} catch {
					entries = [];
				}
			}
			const lines = logLines(entries);
			sections.push([
				`## ${SLOT_LABELS[row.slot]}（${row.step}）`,
				`- 最終失敗: ${jstDisplay(Date.parse(row.closedAt))} JST  attempt: ${row.attempt}${row.jobId ? `  job: ${row.jobId.slice(0, 8)}` : ""}`,
				`- error_code: ${safe(row.code) ?? "不明"}`,
				`- 直近の失敗: ${row.today}件（本日）`,
				"- ログ:",
				...(lines.length ? lines : ["  - ログなし"]),
			]);
		}
		const head = [
			"# Eumenes エラーレポート（メモリー整理）",
			"これはバックグラウンドのメモリー担当（steward）の失敗の診断です。会話本文・設定・認証情報は含みません。",
			"原因の推定と、確認すべきコード・ログを示してください。",
			"",
			"## 概要",
			`- 会話: ${safe(conversationId)?.slice(0, 8) ?? "?"}`,
			`- 失敗中の処理: ${failed.map((row) => `${SLOT_LABELS[row.slot]}（${row.step}）`).join("、")}`,
		];
		const tail = [
			"## 調べ方",
			...failed
				.filter((row) => row.jobId)
				.map((row) => `- bun run logs -- --level warn --id ${row.jobId}`),
			"- docs/logging.md",
		];
		const join = (parts: string[][]) =>
			parts.map((p) => p.join("\n")).join("\n\n");
		// Whole sections are dropped from the end, then the log lines of the first, until the text fits.
		const kept = [...sections];
		let text = join([head, ...kept, tail]);
		while (text.length > STEWARD_REPORT_LIMIT && kept.length > 1) {
			kept.pop();
			text = join([head, ...kept, tail]);
		}
		if (text.length > STEWARD_REPORT_LIMIT) {
			const first = kept[0]!;
			kept[0] = [...first.slice(0, 5), "  - （ログは長すぎるため省略）"];
			text = join([head, ...kept, tail]);
		}
		return text.slice(0, STEWARD_REPORT_LIMIT);
	}

	return { activity, errorReport };
}
