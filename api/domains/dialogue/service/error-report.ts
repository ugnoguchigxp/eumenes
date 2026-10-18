import { homedir } from "node:os";
import { jstDisplay } from "../../../infrastructure/jst-time";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import {
	LOG_SEVERITY,
	logTimeMs,
	readLogEntries,
	type LogEntry,
} from "../../../infrastructure/log-reader";
import type { TaskDto } from "../../agent-runtime";
import type { Run } from "../contracts";
import { byId } from "../repository";

/** The whole report stays within this many characters (about 1,000 to 1,500 tokens). */
export const ERROR_REPORT_LIMIT = 3000;

/** What the report is about: a run that failed, or one that ended with the host's fixed reply to a failed research. */
export type ErrorReportKind = "failed" | "research_failed";

/** The root task of a run is its coordinator. */
const rootOf = (tasks: TaskDto[]) =>
	tasks.find((t) => t.kind === "coordinator" && !t.parentTaskId);

/**
 * Whether a run has an error report. A research failure keeps the root task's code and the run completes
 * with the fixed reply (`researchFailed`); a clarification request is not a failure.
 */
function errorReportKind(
	run: Pick<Run, "status">,
	tasks: TaskDto[],
): ErrorReportKind | null {
	if (run.status === "failed") return "failed";
	const code = rootOf(tasks)?.errorCode;
	if (run.status === "completed" && code && code !== "clarification_required")
		return "research_failed";
	return null;
}

/** Reason code to the section of docs/logging.md that explains it. Add a row when a new reason code appears. */
const REFERENCES: Array<{
	section: string;
	codes?: string[];
	prefixes?: string[];
}> = [
	{
		section: "調査失敗の原因",
		codes: [
			"invalid_control_json",
			"unknown_source",
			"quote_mismatch",
			"SEGMENT_COUNT_LIMIT",
			"CHARACTER_BUDGET_LIMIT",
			"INSPECTION_INCOMPLETE",
		],
		prefixes: ["control_", "web_"],
	},
	{ section: "Codex SDKによる調査の失敗", prefixes: ["codex_research_"] },
	{ section: "LLM生成JSONの補正と拒否", prefixes: ["llm_json_"] },
	{
		section: "LARM正式計数の診断",
		codes: ["chat_token_count_unavailable", "context_budget_exceeded"],
	},
];

function referenceFor(...codes: Array<string | undefined>) {
	for (const code of codes) {
		if (!code) continue;
		const hit = REFERENCES.find(
			(r) =>
				r.codes?.includes(code) || r.prefixes?.some((p) => code.startsWith(p)),
		);
		if (hit) return `docs/logging.md「${hit.section}」`;
	}
	return undefined;
}

/** A value of a known field is printed only when it looks like an identifier or a code, never as free text. */
const SAFE_VALUE = /^[\w.@:+[\]/-]{1,100}$/;
function safe(value: unknown): string | undefined {
	if (typeof value === "number")
		return Number.isFinite(value) ? String(value) : undefined;
	if (typeof value === "boolean") return String(value);
	return typeof value === "string" && SAFE_VALUE.test(value)
		? value
		: undefined;
}
const field = (entry: LogEntry, key: string) => safe(entry[key]);

const seconds = (ms: number) =>
	ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
const duration = (entry: LogEntry) => {
	const ms = Number(entry.durationMs);
	return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
};
const shortId = (id: string | undefined) => (id ? id.slice(0, 8) : undefined);

/** Records that carry a warning level but are not a failure of the run. */
const NOTICE_EVENTS = new Set(["inference.cloud_selected"]);
const FAILURE_EVENT = /(?:_rejected|_failed|_validation_issue)$/;
const COMPONENT_LABELS: Record<string, string> = {
	dialogue: "会話",
	inference: "推論",
	queue: "ジョブ",
	"agent-runtime": "サブエージェント",
	"web-research": "Web取得",
	larm: "LARM",
	"toolchain-history": "ツールチェーン選定",
	"tool-runtime": "ツール実行",
};

/** Fields printed with a failure record, in this order; every other field is left out. */
const DETAIL_KEYS: Array<[label: string, key: string]> = [
	["connection", "connectionId"],
	["upstreamRequest", "upstreamRequestId"],
	["code", "validationCode"],
	["phase", "phase"],
	["action", "controlAction"],
	["schema", "controlSchema"],
	["kind", "kind"],
	["purpose", "purpose"],
	["outcome", "outcome"],
	["exit", "exitCode"],
	["signal", "processSignal"],
];

type Row = {
	at: number;
	stage: string;
	result: string;
	/** A normal-path row: the first to go when the report is too long. */
	normal: boolean;
	count: number;
	total: number;
	statuses: string[];
};

type Classified = "failure" | "normal" | "other";
function classify(entry: LogEntry): Classified {
	const event = String(entry.event);
	const level = LOG_SEVERITY[String(entry.level)] ?? 0;
	if (NOTICE_EVENTS.has(event)) return "other";
	if (
		level >= LOG_SEVERITY.warn! ||
		FAILURE_EVENT.test(event) ||
		event === "dialogue.cancel_requested"
	)
		return "failure";
	const status = entry.status;
	if (event === "toolchain.selection_settled")
		return ["failed", "expired", "cancelled"].includes(String(entry.outcome))
			? "failure"
			: "normal";
	if (event === "agent.state_changed")
		return ["failed", "cancelled", "interrupted"].includes(String(status))
			? "failure"
			: "normal";
	if (event === "queue.settled")
		return status === "completed" ? "normal" : "failure";
	return "other";
}

/** The reason of a record: its reason code, else the violation it reports. */
const reasonOf = (entry: LogEntry) =>
	field(entry, "reason") ?? field(entry, "validationCode");

/** The one-line result of a failure record: reason, then the fixed details. */
function describeFailure(entry: LogEntry) {
	const event = String(entry.event);
	const reason = reasonOf(entry);
	if (event === "agent.control_validation_issue") {
		const expected = field(entry, "expectedType");
		const actual = field(entry, "actualType");
		return [
			field(entry, "validationPath"),
			field(entry, "validationCode"),
			expected || actual ? `${expected ?? "?"}→${actual ?? "?"}` : undefined,
		]
			.filter(Boolean)
			.join(" ");
	}
	const parts = DETAIL_KEYS.flatMap(([label, key]) => {
		const value = field(entry, key);
		return value === undefined ? [] : [`${label}=${value}`];
	});
	return [reason, parts.length ? `（${parts.join(" ")}）` : ""].join("");
}

/** Records that are the same failure but for the repair attempt and the status fold into one row. */
function foldKey(entry: LogEntry) {
	return [
		entry.component,
		entry.event,
		reasonOf(entry),
		entry.phase,
		entry.controlAction,
		entry.validationPath,
		entry.validationCode,
		entry.taskId,
	]
		.map((v) => safe(v) ?? "")
		.join("|");
}

type Built = {
	rows: Row[];
	first?: LogEntry;
	issue?: LogEntry;
	bootId?: string;
	ignored: number;
	started?: number;
	toolchainId?: string;
};

/** Records that only echo a failure settled elsewhere; they carry its code but do not say where it began. */
const ECHO_EVENTS = new Set(["toolchain.selection_settled", "queue.settled"]);

/**
 * The failure the run ended with, among the failure records: one that carries the run's final failure code
 * (the run's error or the root task's code), has the status `failed`, or is the request to cancel. A repaired
 * violation or a warning the run went on from (`dialogue.recall_failed`) is a row of the table, not the cause.
 * The earliest record of the same failure (repeats fold into one row) is where it began. Records that only
 * echo the settlement do not count; when no other record matches, the oldest failure is taken.
 */
function pickFirst(
	failures: LogEntry[],
	finalCodes: ReadonlySet<string>,
): LogEntry | undefined {
	const final = failures.find(
		(entry) =>
			!ECHO_EVENTS.has(String(entry.event)) &&
			(entry.status === "failed" ||
				entry.event === "dialogue.cancel_requested" ||
				[reasonOf(entry), field(entry, "errorCode")].some(
					(code) => code !== undefined && finalCodes.has(code),
				)),
	);
	if (!final) return failures[0];
	const key = foldKey(final);
	return failures.find((entry) => foldKey(entry) === key) ?? final;
}

function build(entries: LogEntry[], finalCodes: ReadonlySet<string>): Built {
	const failures: LogEntry[] = [];
	const rows = new Map<string, Row>();
	const built: Built = { rows: [], ignored: 0 };
	const add = (
		key: string,
		entry: LogEntry,
		stage: string,
		result: string,
		normal: boolean,
		extra?: { ms?: number; status?: string },
	) => {
		const at = logTimeMs(entry);
		const row = rows.get(key);
		if (row) {
			row.count++;
			row.total += extra?.ms ?? 0;
			if (extra?.status && !row.statuses.includes(extra.status))
				row.statuses.push(extra.status);
			return;
		}
		rows.set(key, {
			at,
			stage,
			result,
			normal,
			count: 1,
			total: extra?.ms ?? 0,
			statuses: extra?.status ? [extra.status] : [],
		});
	};
	for (const entry of entries) {
		const time = logTimeMs(entry);
		if (!Number.isFinite(time)) continue;
		built.started ??= time;
		built.bootId ??= field(entry, "bootId");
		const event = String(entry.event);
		const component = safe(entry.component) ?? "";
		const kind = classify(entry);
		if (event === "toolchain.selection_recorded")
			built.toolchainId ??= field(entry, "toolchainId");
		if (kind === "failure") {
			failures.push(entry);
			const task = shortId(field(entry, "taskId"));
			add(
				foldKey(entry),
				entry,
				`${event}${task && component === "agent-runtime" ? ` [${task}]` : ""}`,
				describeFailure(entry),
				false,
				{ status: field(entry, "status") },
			);
			continue;
		}
		switch (event) {
			case "dialogue.accepted":
				add(event, entry, "受付", "queued", true);
				break;
			case "dialogue.request_analyzed": {
				const ms = duration(entry);
				add(
					event,
					entry,
					"R1 依頼分析",
					`${field(entry, "kind") ?? "?"} / ${field(entry, "next") ?? "?"}${ms === undefined ? "" : `（${seconds(ms)}）`}`,
					true,
				);
				break;
			}
			case "dialogue.candidates_selected":
				add(
					event,
					entry,
					"候補検索",
					`${field(entry, "candidateCount") ?? "?"}件（${field(entry, "retrieval") ?? "?"}）`,
					true,
				);
				break;
			case "toolchain.selection_recorded":
				add(
					event,
					entry,
					"選定",
					`${field(entry, "decision") ?? "?"}${field(entry, "toolchainId") ? ` ${field(entry, "toolchainId")}` : ""}`,
					true,
				);
				break;
			case "toolchain.selection_settled":
				add(event, entry, "選定の確定", field(entry, "outcome") ?? "?", true);
				break;
			case "dialogue.generation_started":
				add(event, entry, "回答生成", "開始", true);
				break;
			case "inference.attempt_succeeded":
				add(
					`${event}|${field(entry, "purpose")}`,
					entry,
					`推論 ${field(entry, "purpose") ?? ""}`.trim(),
					"成功",
					true,
					{ ms: duration(entry) },
				);
				break;
			case "agent.state_changed":
				add(
					`${event}|${field(entry, "taskId")}`,
					entry,
					`サブエージェント ${field(entry, "kind") ?? ""} [${shortId(field(entry, "taskId")) ?? "?"}]`.replace(
						"  ",
						" ",
					),
					"状態遷移",
					true,
				);
				break;
			case "agent.tool_completed":
				add(
					`${event}|${field(entry, "kind")}`,
					entry,
					`ツール ${field(entry, "kind") ?? ""}`.trim(),
					"完了",
					true,
				);
				break;
			case "web.completed":
				add(event, entry, "Web取得", "完了", true);
				break;
			case "queue.settled":
				add(event, entry, "ジョブ", "完了", true, { ms: duration(entry) });
				break;
			default:
				built.ignored++;
		}
	}
	built.rows = [...rows.values()].sort((a, b) => a.at - b.at);
	built.first = pickFirst(failures, finalCodes);
	// The violation of the first failure is the issue record of the same step.
	const first = built.first;
	if (first)
		built.issue = failures.find(
			(entry) =>
				entry.event === "agent.control_validation_issue" &&
				entry.stepId === first.stepId,
		);
	return built;
}

function rowText(row: Row, base: number) {
	let result = row.result;
	const status =
		row.statuses.length > 1
			? `status: ${row.statuses.join("→")}`
			: row.statuses.length === 1 && !row.normal
				? `status=${row.statuses[0]}`
				: undefined;
	if (status)
		result = result.endsWith("）")
			? `${result.slice(0, -1)} ${status}）`
			: `${result}（${status}）`;
	if (row.count > 1) {
		const total = row.total > 0 ? `・計${seconds(row.total)}` : "";
		result += ` ×${row.count}${total}`;
	}
	const elapsed = `${((row.at - base) / 1000).toFixed(1)}s`;
	return `| ${elapsed} | ${row.stage} | ${result.replaceAll("|", "/")} |`;
}

function frames(entry: LogEntry): string | undefined {
	if (!Array.isArray(entry.errorFrames)) return undefined;
	const root = process.cwd().replace(/\/$/, "") + "/";
	// A path outside the working directory still must not show the account name of the home directory.
	const homeDir = homedir().replace(/\/$/, "");
	const home = homeDir ? `${homeDir}/` : undefined;
	const list = entry.errorFrames
		.filter((f): f is string => typeof f === "string" && f.length <= 200)
		.slice(0, 2)
		.map((f) =>
			f.startsWith(root)
				? f.slice(root.length)
				: home && f.startsWith(home)
					? `~/${f.slice(home.length)}`
					: f,
		);
	return list.length ? list.join(" ← ") : undefined;
}

function stageOf(entry: LogEntry, toolchainId: string | undefined) {
	const component = safe(entry.component) ?? "?";
	const label = COMPONENT_LABELS[component] ?? component;
	if (component === "agent-runtime") {
		const detail = [toolchainId, field(entry, "kind"), field(entry, "phase")]
			.filter(Boolean)
			.join(" / ");
		return `${label}${detail ? `（${detail}）` : ""}`;
	}
	return `${label}（${safe(entry.event) ?? "?"}）`;
}

type ErrorReportInput = {
	run: Pick<
		Run,
		"id" | "status" | "error" | "requestId" | "jobId" | "updatedAt"
	>;
	kind: ErrorReportKind;
	tasks: TaskDto[];
	entries: LogEntry[];
	/** True when no log was available to read (disabled or missing). */
	logMissing?: boolean;
};

/** The fixed-format diagnostic text of a failed run; see spec/run-error-report-design-2026-10-17.md. */
function formatErrorReport(input: ErrorReportInput): string {
	const { run, kind, tasks, entries } = input;
	const root = rootOf(tasks);
	const code = kind === "failed" ? safe(run.error) : safe(root?.errorCode);
	const built = build(
		entries,
		new Set(
			[safe(run.error), safe(root?.errorCode)].filter(
				(c): c is string => c !== undefined,
			),
		),
	);
	const first = built.first;
	const issue = built.issue;
	const failedTask =
		tasks.find((t) => t.errorCode && t.id !== root?.id) ?? root;
	const at = Date.parse(run.updatedAt);
	const ended = Number.isFinite(at)
		? at
		: (built.rows.at(-1)?.at ?? Date.now());
	const stage = first
		? stageOf(first, built.toolchainId)
		: failedTask?.errorCode
			? `サブエージェント（${safe(failedTask.kind) ?? "?"} / ${safe(failedTask.phase) ?? "?"}）`
			: "不明（ログに失敗の記録がありません）";
	const result =
		kind === "failed"
			? `failed / ${code ?? "不明"}`
			: `completed / 調査失敗の固定返答 / ${code ?? "不明"}`;
	const taskLines = tasks
		.slice(0, 4)
		.map(
			(t) =>
				`${safe(t.kind) ?? "?"}[${shortId(safe(t.id)) ?? "?"}] ${safe(t.status) ?? "?"}${t.errorCode ? ` / ${safe(t.errorCode) ?? "?"}` : ""}`,
		);
	const head = [
		"# Eumenes エラーレポート",
		"これは失敗した会話処理の診断です。会話本文・設定・認証情報は含みません。",
		"原因の推定と、確認すべきコード・ログを示してください。",
		"",
		"## 概要",
		`- 発生: ${jstDisplay(ended)} JST${built.bootId ? `  boot: ${built.bootId}` : ""}`,
		`- 結果: ${result}`,
		`- 失敗した段階: ${stage}`,
		...(taskLines.length ? [`- タスク: ${taskLines.join(" ; ")}`] : []),
	];
	const failureLines: string[] = [];
	if (first) {
		const reason = reasonOf(first) ?? reasonOf(issue ?? {});
		failureLines.push(
			`- component: ${safe(first.component) ?? "?"}  event: ${safe(first.event) ?? "?"}`,
		);
		const parts = [
			reason ? `reason: ${reason}` : undefined,
			field(issue ?? first, "validationPath")
				? `validationPath: ${field(issue ?? first, "validationPath")}`
				: undefined,
			field(issue ?? first, "validationCode")
				? `validationCode: ${field(issue ?? first, "validationCode")}`
				: undefined,
			field(issue ?? first, "expectedType")
				? `expected: ${field(issue ?? first, "expectedType")}`
				: undefined,
			field(issue ?? first, "actualType")
				? `actual: ${field(issue ?? first, "actualType")}`
				: undefined,
		].filter(Boolean);
		if (parts.length) failureLines.push(`- ${parts.join("  ")}`);
		const where = frames(first);
		if (where) failureLines.push(`- 場所: ${where}`);
		const ref = referenceFor(
			reasonOf(first),
			field(issue ?? first, "validationCode"),
			code,
		);
		if (ref) failureLines.push(`- 参考: ${ref}`);
	} else {
		failureLines.push(
			`- ログに失敗の記録が見つかりません（${input.logMissing ? "ログを読めません" : "保持期間外、または出力レベルが警告より高い"}）`,
		);
		if (code) failureLines.push(`- reason: ${code}`);
		const ref = referenceFor(code);
		if (ref) failureLines.push(`- 参考: ${ref}`);
	}
	const taskId = safe(first?.taskId) ?? safe(failedTask?.id);
	const ids = [
		`runId: ${run.id}`,
		safe(run.requestId) ? `requestId: ${run.requestId}` : undefined,
		safe(run.jobId) ? `jobId: ${run.jobId}` : undefined,
		taskId ? `taskId: ${taskId}` : undefined,
		safe(first?.stepId) ? `stepId: ${safe(first?.stepId)}` : undefined,
	].filter(Boolean);
	const tail = [
		"",
		"## 追跡用",
		`- ${ids.join(" / ")}`,
		`- bun run logs -- --id ${run.id} --json`,
		...(taskId ? [`- bun run logs -- --id ${taskId} --level warn --json`] : []),
	];
	const base = built.started ?? ended;
	const failureBlock = ["", "## 最初の失敗", ...failureLines];
	const render = (rows: Row[], omitted: number) => [
		...head,
		"",
		"## 経過（正常系は集約）",
		...(rows.length
			? [
					"| 経過 | 段階 | 結果 |",
					"| --- | --- | --- |",
					...rows.map((r) => rowText(r, base)),
				]
			: ["（記録なし）"]),
		...(omitted || built.ignored
			? [
					`（${[
						omitted ? `古い行を ${omitted} 件省略` : "",
						built.ignored
							? `その他の正常系 ${built.ignored} 行は集約・省略`
							: "",
					]
						.filter(Boolean)
						.join("、")}）`,
				]
			: []),
		...failureBlock,
		...tail,
	];
	// Too long: the oldest normal rows go first, then the oldest failure rows (the first failure stays).
	let rows = built.rows;
	let omitted = 0;
	let text = render(rows, omitted).join("\n");
	while (text.length > ERROR_REPORT_LIMIT && rows.length) {
		const drop =
			rows.findIndex((r) => r.normal) >= 0
				? rows.findIndex((r) => r.normal)
				: 0;
		rows = rows.filter((_, i) => i !== drop);
		omitted++;
		text = render(rows, omitted).join("\n");
	}
	return text.length > ERROR_REPORT_LIMIT
		? `${text.slice(0, ERROR_REPORT_LIMIT - 1)}…`
		: text;
}

export type ErrorReportResult =
	| { ok: true; runId: string; text: string }
	| { ok: false; reason: "not_found" | "not_applicable" };

/**
 * The error report of a run: the run's own state, the tasks the agent runtime holds for it (public read), and
 * the log records that carry the run's IDs. Nothing is read from another domain's tables.
 */
export function createErrorReport(deps: {
	store: SqliteStore;
	agents?: { list(rootRunId: string): TaskDto[] };
	/** The operational log file the backend writes (`config.logFile`); undefined when the file log is disabled. */
	logFile: () => string | undefined;
}) {
	return async function errorReport(runId: string): Promise<ErrorReportResult> {
		const run = deps.store.read((db) => byId(db, runId));
		if (!run) return { ok: false, reason: "not_found" };
		const tasks =
			run.agentTaskId && deps.agents ? deps.agents.list(run.id) : [];
		const kind = errorReportKind(run, tasks);
		if (!kind) return { ok: false, reason: "not_applicable" };
		const file = deps.logFile();
		let entries: LogEntry[] = [];
		if (file) {
			try {
				// The IDs the run's own records name lead to the rest: its jobs, tasks, tool calls and Web runs.
				const own = await readLogEntries(file, [run.id]);
				const related = new Set<string>([run.id, run.requestId]);
				if (run.jobId) related.add(run.jobId);
				for (const task of tasks) related.add(task.id);
				for (const entry of own)
					for (const key of [
						"requestId",
						"jobId",
						"taskId",
						"invocationId",
						"operationId",
					]) {
						const value = entry[key];
						if (typeof value === "string") related.add(value);
					}
				entries = await readLogEntries(file, related);
			} catch {
				entries = [];
			}
		}
		return {
			ok: true,
			runId: run.id,
			text: formatErrorReport({
				run,
				kind,
				tasks,
				entries,
				logMissing: !file || entries.length === 0,
			}),
		};
	};
}
