import type { Database } from "bun:sqlite";
import { getLogger } from "../../../infrastructure/logger";
import type { TerminalTaskState } from "../contracts";
import {
	HISTORY_ACTIONS,
	HISTORY_CHAIN,
	HISTORY_CODE_CHARS,
	HISTORY_REQUEST_CHARS,
	HISTORY_STEPS,
	REDACTED_VALUE,
	type HistoryAction,
	type HistorySlot,
	type StoredVariable,
} from "../contracts/history";
import type { ScriptView } from "../contracts/script";
import {
	historyRow,
	insertHistory,
	markHistoryFailed,
	replaceHistory,
	taskRow,
	type CaptureRow,
	type HistoryContent,
	type OperationRow,
	type TaskRow,
} from "../repository";
import type { Ctx } from "./context";
import { gotoCode } from "./history-source";
import {
	maskCode,
	maskPlace,
	maskUrl,
	redactedLiteral,
	replaceTypedArgument,
	replaceValues,
	type VarValue,
} from "./history-values";
import { declaredBefore, scriptOf } from "./script";

const log = getLogger("browser");
const SLOTS_PER_VARIABLE = 10;

/** What `planOperation` kept of an operation (see `Planned.detail`). */
type Detail = {
	element?: string;
	url?: string;
	key?: string;
	values?: string[];
	text?: string;
	textGone?: string;
	seconds?: number;
	purpose?: string;
	origin?: string;
	provenance?: string;
	variable?: string;
	value?: string;
	effect?: HistoryAction["effect"];
	commit?: boolean;
};

/** The task and the tasks it was continued from after an approval, oldest first (spec §4). */
function chainOf(db: Database, task: TaskRow) {
	const chain = [task];
	let next = task.continued_from;
	while (next && chain.length < HISTORY_CHAIN) {
		const prior = taskRow(db, next);
		if (!prior || prior.owner !== task.owner) break;
		chain.unshift(prior);
		next = prior.continued_from;
	}
	return chain;
}

const observedOperations = (db: Database, taskId: string) =>
	db
		.query(
			"SELECT * FROM browser_operations WHERE task_id=? AND state='observed' ORDER BY created_at, rowid",
		)
		.all(taskId) as OperationRow[];
const savedCaptures = (db: Database, taskId: string) =>
	db
		.query(
			"SELECT * FROM browser_captures WHERE task_id=? AND state='local_ready' ORDER BY created_at, rowid",
		)
		.all(taskId) as CaptureRow[];

/** The step's label in the Script it was bound to, also when a later revision dropped the step. */
function stepLabelOf(script: ScriptView | null, stepId: string | null) {
	if (!script || !stepId) return undefined;
	for (const r of [script, ...[...script.history].reverse()]) {
		const step = r.steps.find((s) => s.stepId === stepId);
		if (step) return step.label;
	}
	return undefined;
}

const placeOf = (url: string | null) =>
	url ? url.replace(/^https?:\/\//, "") : undefined;
const hostOf = (action: HistoryAction) => {
	if (action.url)
		try {
			return new URL(action.url.replace(/\{\{[^}]*\}\}/g, "x")).hostname;
		} catch {}
	return action.place?.split("/")[0] ?? "";
};

type Known = { vars: VarValue[]; declared: ReadonlySet<string> };

/** One observed operation as the history keeps it: values of this run are replaced (spec §5). */
function operationAction(
	op: OperationRow,
	stepLabel: string | undefined,
	known: Known,
): Omit<HistoryAction, "seq"> {
	const d = JSON.parse(op.detail_json ?? "{}") as Detail;
	const text = (s: string) => replaceValues(s, known.vars);
	const a: Omit<HistoryAction, "seq"> = {
		kind: op.tool_kind as HistoryAction["kind"],
		...(stepLabel ? { stepLabel: text(stepLabel) } : {}),
		...(d.element ? { element: text(d.element) } : {}),
		...(d.purpose ? { purpose: text(d.purpose) } : {}),
		...(d.effect ? { effect: d.effect } : {}),
		...(placeOf(op.result_url)
			? { place: maskPlace(placeOf(op.result_url)!, known.vars) }
			: {}),
	};
	let code = op.code ?? undefined;
	if (d.url) {
		a.url = maskUrl(d.url, known.vars);
		// The URL as the browser ran it may spell a value in ways the code cannot be matched on.
		if (a.url !== d.url && ["navigate", "tab_new"].includes(op.tool_kind))
			code = gotoCode(a.url);
	}
	if (op.tool_kind === "type") {
		const variable =
			d.variable && known.declared.has(d.variable) ? d.variable : undefined;
		if (variable) {
			a.variable = variable;
			if (code) code = replaceTypedArgument(code, `vars.${variable}`);
		} else if (d.provenance !== "request" || d.variable) {
			a.value = REDACTED_VALUE;
			if (code) code = replaceTypedArgument(code, redactedLiteral);
		} else if (d.value !== undefined) a.value = text(d.value);
	}
	if (d.values) a.value = text(d.values.join(", "));
	if (d.key) a.value = d.key;
	if (d.text || d.textGone || d.seconds)
		a.value = text(
			[
				d.text,
				d.textGone ? `消える: ${d.textGone}` : undefined,
				d.seconds ? `${d.seconds}秒` : undefined,
			]
				.filter(Boolean)
				.join(", "),
		);
	if (code) a.code = maskCode(code, known.vars).slice(0, HISTORY_CODE_CHARS);
	return a;
}

function captureAction(
	c: CaptureRow,
	stepLabel: string | undefined,
	known: Known,
): Omit<HistoryAction, "seq"> {
	return {
		kind: "capture",
		...(stepLabel ? { stepLabel: replaceValues(stepLabel, known.vars) } : {}),
		value: c.range,
	};
}

/** The slots a variable was typed into, from the operations that typed it. */
function slotsOf(name: string, ops: readonly OperationRow[]) {
	const slots: HistorySlot[] = [];
	for (const op of ops) {
		const d = JSON.parse(op.detail_json ?? "{}") as Detail;
		if (op.tool_kind !== "type" || d.variable !== name || !d.origin) continue;
		const slot = {
			origin: d.origin,
			purpose: d.purpose ?? "",
			element: d.element ?? "",
		};
		if (
			slots.length < SLOTS_PER_VARIABLE &&
			!slots.some(
				(s) =>
					s.origin === slot.origin &&
					s.purpose === slot.purpose &&
					s.element === slot.element,
			)
		)
			slots.push(slot);
	}
	return slots;
}

/** What the finished run teaches: null when it did nothing a history can keep (spec §4). */
function contentOf(
	db: Database,
	chain: readonly TaskRow[],
	script: ScriptView,
): HistoryContent | null {
	const scripts = chain.map(scriptOf);
	const ops = chain.flatMap((t) => observedOperations(db, t.id));
	if (!ops.length || !script.title) return null;
	// Every value any revision of any task of the chain declared is kept out, whichever Script names it last.
	const vars = scripts.flatMap((s) =>
		declaredBefore(s).map((v) => ({ name: v.name, value: v.value })),
	);
	const known: Known = {
		vars,
		declared: new Set((script.variables ?? []).map((v) => v.name)),
	};
	const text = (s: string) => replaceValues(s, vars);
	const rows: {
		at: number;
		make: () => Omit<HistoryAction, "seq">;
	}[] = [];
	chain.forEach((t, i) => {
		for (const op of observedOperations(db, t.id))
			rows.push({
				at: op.created_at,
				make: () =>
					operationAction(
						op,
						stepLabelOf(scripts[i]!, op.script_step_id),
						known,
					),
			});
		for (const c of savedCaptures(db, t.id))
			rows.push({
				at: c.created_at,
				make: () =>
					captureAction(c, stepLabelOf(scripts[i]!, c.script_step_id), known),
			});
	});
	// A stable sort keeps the operations before a capture of the same instant, and the chain in order.
	const actions = rows
		.sort((a, b) => a.at - b.at)
		.slice(0, HISTORY_ACTIONS)
		.map((r, i) => ({ seq: i + 1, ...r.make() }));
	const first = actions.find((a) => a.url || a.place);
	const variables: StoredVariable[] = (script.variables ?? []).map((v) => ({
		name: v.name,
		label: v.label,
		slots: slotsOf(v.name, ops),
	}));
	return {
		title: script.title,
		request: text(chain[0]!.request).slice(0, HISTORY_REQUEST_CHARS),
		place: first ? hostOf(first) : "",
		variables,
		steps: script.steps.slice(0, HISTORY_STEPS).map((s) => ({
			label: text(s.label),
			expectation: text(s.expectation),
		})),
		actions,
		sourceTaskId: chain.at(-1)!.id,
		hasCommit: ops.some(
			(op) => (JSON.parse(op.detail_json ?? "{}") as Detail).commit === true,
		),
	};
}

/**
 * Saves or updates the history of a task that just ended, in the transaction that ended it (spec §4). It
 * decides from the ledgers alone; no model is asked. A completed run with something to keep creates a history
 * or replaces the one its Script followed; a failed one only counts against the followed history.
 */
export function recordHistory(
	ctx: Ctx,
	db: Database,
	task: TaskRow,
	state: TerminalTaskState,
) {
	// A history is a by-product: failing to keep one must never keep the task from ending, nor leave half of it.
	db.exec("SAVEPOINT browser_history_record");
	try {
		saveHistory(ctx, db, task, state);
		db.exec("RELEASE browser_history_record");
	} catch (e) {
		db.exec("ROLLBACK TO browser_history_record");
		db.exec("RELEASE browser_history_record");
		log.warn("browser.history_failed", { taskId: task.id }, e);
	}
}

function saveHistory(
	ctx: Ctx,
	db: Database,
	task: TaskRow,
	state: TerminalTaskState,
) {
	if (state !== "completed" && state !== "failed" && state !== "indeterminate")
		return;
	const script = scriptOf(task);
	if (!script) return;
	const found = script.historyId ? historyRow(db, script.historyId) : null;
	const followed = found && found.owner === task.owner ? found : null;
	const now = ctx.now();
	if (state !== "completed") {
		if (!followed) return;
		markHistoryFailed(db, followed.id, now);
		log.info("browser.history_saved", {
			subjectId: followed.id,
			taskId: task.id,
			kind: "failed",
		});
		return;
	}
	const content = contentOf(db, chainOf(db, task), script);
	if (!content) return;
	const id = followed?.id ?? crypto.randomUUID();
	if (followed) replaceHistory(db, id, content, now);
	else insertHistory(db, id, task.owner, content, now);
	log.info("browser.history_saved", {
		subjectId: id,
		taskId: task.id,
		kind: followed ? "updated" : "created",
		count: content.actions.length,
	});
}
