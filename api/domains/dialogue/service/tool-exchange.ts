import type { UtteranceToolCall } from "../../conversation";
import {
	READ_NOTE,
	SET_QUIET,
	SHOW_NOTE,
	START_PREPARATION,
} from "eumenes-agency/agenda";
import { goalReplyToolNames } from "eumenes-agency/agenda/runtime";
import { TOOL_NAMES } from "./generation-tools";
import { jstNowLine } from "./input-text";
import type { DocumentRefs } from "./work-items";

/**
 * The tools whose calls and normalized results stay in the working conversation epoch until compaction
 * (`spec/conversation-cache-compaction-and-history-design-2026-11-22.md`, §3).
 */
const AGENDA_TOOLS = new Set<string>([
	START_PREPARATION,
	READ_NOTE,
	SHOW_NOTE,
	SET_QUIET,
]);
const GOAL_TOOLS = new Set<string>(goalReplyToolNames);
const READ_TOOL_NAMES = new Set<string>([
	"read_memory",
	"read_history",
	"read_runs",
	"read_agents",
	"read_world",
]);
const LOOKUP_TOOL = "lookup_public_information";
const WORK_CONTROL_TOOLS = new Set<string>([
	"approve_confirmation",
	"decline_confirmation",
	TOOL_NAMES.work,
	"discard_for_pending_switch",
	TOOL_NAMES.memory,
]);

/** The step a routed turn keeps when it asked back instead of choosing (the local harness rebuild plan, 4.3). */
export const ASK_STEP = "ask";

const CARRIED = new Set<string>([
	...AGENDA_TOOLS,
	...GOAL_TOOLS,
	...READ_TOOL_NAMES,
	LOOKUP_TOOL,
	...WORK_CONTROL_TOOLS,
	TOOL_NAMES.search,
	TOOL_NAMES.delegate,
	ASK_STEP,
]);

/** Carried tools that exist as real native tools and can be replayed in `assistant.tool_calls` + `tool` history. */
const REPLAYABLE = new Set<string>(
	[...CARRIED].filter((name) => name !== ASK_STEP),
);

/** Per-category character caps for immutable tool result snapshots (§3.1). */
const RESULT_CHARS = {
	readNote: 4000,
	agendaOther: 800,
	readTool: 2000,
	goal: 1500,
	lookup: 1500,
	searchDelegate: 1200,
	workControl: 1000,
	turnTotal: 6000,
} as const;

/** One call of a turn as it ran: the model's call and the host's result (`{ refused: true }` for a refused call). */
export type ExchangeStep = { name: string; arguments: string; result: unknown };

export const carriesExchange = (name: string) => CARRIED.has(name);

/** A completed empty search also replaces the previous list. Refused calls carry no search result. */
export function lastShownSearch(steps: readonly ExchangeStep[]) {
	for (let i = steps.length - 1; i >= 0; i--) {
		const step = steps[i]!;
		const value = recordOf(step.result);
		if (
			step.name === TOOL_NAMES.search &&
			Array.isArray(value.sources) &&
			Array.isArray(value.candidates)
		)
			return {
				sources: value.sources,
				candidates: value.candidates.map((c) => ({
					id: recordOf(c).id,
					revisionId: recordOf(c).revisionId,
				})),
			};
	}
}

/** A carried argument string shows at most this many characters; the rest is cut with `…`. */
export const ARGUMENT_CHARS = 300;

const recordOf = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};

function clipText(
	text: string,
	maxChars: number,
	suffix = "…（省略）",
): string {
	if (text.length <= maxChars) return text;
	if (maxChars <= suffix.length) return text.slice(0, Math.max(0, maxChars));
	return `${text.slice(0, maxChars - suffix.length)}${suffix}`;
}

function tryParseJson(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return undefined;
	}
}

/** Recursively clips string fields and array lengths so the serialized JSON stays valid within `maxChars`. */
function trimJsonValue(
	value: unknown,
	strCap: number,
	arrayCap: number,
): unknown {
	if (typeof value === "string")
		return value.length > strCap ? `${value.slice(0, strCap)}…` : value;
	if (Array.isArray(value))
		return value
			.slice(0, arrayCap)
			.map((item) => trimJsonValue(item, strCap, arrayCap));
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>).map(([k, v]) => [
				k,
				trimJsonValue(v, strCap, arrayCap),
			]),
		);
	return value;
}

/** Serializes `value` as valid JSON within `maxChars` by progressively tightening field/array bounds (never slicing JSON). */
function boundedJson(value: unknown, maxChars: number): string {
	const direct = JSON.stringify(value);
	if (direct.length <= maxChars) return direct;
	for (const [strCap, arrayCap] of [
		[240, 12],
		[140, 8],
		[80, 6],
		[48, 4],
		[24, 3],
	] as const) {
		const trimmed = trimJsonValue(value, strCap, arrayCap);
		const json = JSON.stringify(trimmed);
		if (json.length <= maxChars) return json;
	}
	const rec = recordOf(value);
	if (Array.isArray(rec.candidates)) {
		const minimal = {
			...(rec.sources ? { sources: rec.sources } : {}),
			candidates: rec.candidates.slice(0, 3).map((c) => {
				const item = recordOf(c);
				return {
					id: item.id,
					...(item.revisionId ? { revisionId: item.revisionId } : {}),
					...(typeof item.title === "string"
						? { title: clipText(item.title, 32, "…") }
						: {}),
				};
			}),
			truncated: true,
		};
		const json = JSON.stringify(minimal);
		if (json.length <= maxChars) return json;
		return JSON.stringify({ candidates: minimal.candidates, truncated: true });
	}
	const compact: Record<string, unknown> = { truncated: true };
	for (const key of [
		"status",
		"code",
		"todo",
		"confirmation",
		"delegated",
		"accepted",
		"answered",
		"refused",
		"fetchedAt",
		"id",
		"slot",
	])
		if (rec[key] !== undefined) compact[key] = rec[key];
	return JSON.stringify(compact);
}

/**
 * A result as later turns see it for `find_toolchain` / `delegate` / `ask`: keeps the exact SQL-compatible
 * JSON structure (`latestReplyWithTool` inspects `$.candidates`).
 */
function carriedSearchOrDelegate(
	name: string,
	result: unknown,
	refs: DocumentRefs,
): Record<string, unknown> {
	const record = recordOf(result);
	if (record.refused === true) return { refused: true };
	if (name === ASK_STEP) return {};
	if (name === TOOL_NAMES.search)
		return {
			...(record.sources ? { sources: record.sources } : {}),
			candidates: (Array.isArray(record.candidates)
				? record.candidates
				: []
			).map((candidate) => {
				const c = recordOf(candidate);
				return {
					id: c.id,
					...(c.revisionId ? { revisionId: c.revisionId } : {}),
					title: c.title,
					summary: c.summary,
					...(c.execution ? { execution: c.execution } : {}),
				};
			}),
		};
	if (typeof record.confirmation === "string")
		return { confirmation: record.confirmation };
	if (record.delegated === true) {
		const todo =
			typeof record.todo === "string" ? refs.todo(record.todo) : null;
		return todo ? { todo } : { delegated: true };
	}
	if (typeof record.answered === "boolean")
		return { answered: record.answered };
	return { delegated: false };
}

/**
 * A call's arguments as later turns replay them: always a JSON object (a call the host refused for its form may not
 * be one, and a provider rejects such a call in the history), each text within `ARGUMENT_CHARS`.
 */
function carriedArguments(raw: string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return "{}";
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		return "{}";
	const bounded = (value: unknown): unknown =>
		typeof value === "string"
			? value.length > ARGUMENT_CHARS
				? `${value.slice(0, ARGUMENT_CHARS)}…`
				: value
			: Array.isArray(value)
				? value.map(bounded)
				: value && typeof value === "object"
					? Object.fromEntries(
							Object.entries(value).map(([key, v]) => [key, bounded(v)]),
						)
					: value;
	return JSON.stringify(bounded(parsed));
}

function normalizeStepResult(
	step: ExchangeStep,
	refs: DocumentRefs,
	nowMs: number,
	maxCharsOverride?: number,
): string {
	const cap = (base: number) =>
		maxCharsOverride !== undefined ? Math.min(base, maxCharsOverride) : base;
	if (AGENDA_TOOLS.has(step.name)) {
		const limit = cap(
			step.name === READ_NOTE
				? RESULT_CHARS.readNote
				: RESULT_CHARS.agendaOther,
		);
		const text = typeof step.result === "string" ? step.result : "";
		return clipText(text, limit);
	}
	if (READ_TOOL_NAMES.has(step.name)) {
		const rec = recordOf(step.result);
		const text =
			typeof step.result === "string"
				? step.result
				: typeof rec.text === "string"
					? rec.text
					: JSON.stringify(rec);
		return clipText(text, cap(RESULT_CHARS.readTool));
	}
	if (GOAL_TOOLS.has(step.name)) {
		const parsed =
			typeof step.result === "string" ? tryParseJson(step.result) : step.result;
		if (parsed !== undefined)
			return boundedJson(parsed, cap(RESULT_CHARS.goal));
		return clipText(String(step.result ?? ""), cap(RESULT_CHARS.goal));
	}
	if (step.name === LOOKUP_TOOL) {
		const parsed =
			typeof step.result === "string" ? tryParseJson(step.result) : step.result;
		const value =
			parsed && typeof parsed === "object" && !Array.isArray(parsed)
				? {
						fetchedAt: jstNowLine(nowMs),
						...(parsed as Record<string, unknown>),
					}
				: { fetchedAt: jstNowLine(nowMs), text: String(step.result ?? "") };
		return boundedJson(value, cap(RESULT_CHARS.lookup));
	}
	if (WORK_CONTROL_TOOLS.has(step.name)) {
		const parsed =
			typeof step.result === "string" ? tryParseJson(step.result) : step.result;
		return boundedJson(parsed ?? {}, cap(RESULT_CHARS.workControl));
	}
	return boundedJson(
		carriedSearchOrDelegate(step.name, step.result, refs),
		cap(RESULT_CHARS.searchDelegate),
	);
}

/** The exchange of a turn to keep with the agent's utterance that ends it, bounded per-tool and per-turn. */
export function carriedToolCalls(
	steps: readonly ExchangeStep[],
	refs: DocumentRefs,
	nowMs = Date.now(),
): UtteranceToolCall[] {
	const kept = steps.filter((step) => carriesExchange(step.name));
	const calls = kept.map((step) => ({
		name: step.name,
		arguments: carriedArguments(step.arguments),
		result: normalizeStepResult(step, refs, nowMs),
	}));
	let total = calls.reduce((sum, c) => sum + c.result.length, 0);
	// Enforce per-turn result cap from the newest steps backwards, preserving valid JSON on JSON tools.
	for (
		let i = calls.length - 1;
		i >= 0 && total > RESULT_CHARS.turnTotal;
		i--
	) {
		const excess = total - RESULT_CHARS.turnTotal;
		const current = calls[i]!;
		const target = Math.max(120, current.result.length - excess);
		const shrunk = normalizeStepResult(kept[i]!, refs, nowMs, target);
		total -= current.result.length - shrunk.length;
		current.result = shrunk;
	}
	return calls;
}

/** The agenda tool calls an agent utterance carries (legacy subset helper). */
export function agendaCalls(utterance: {
	toolCalls: readonly UtteranceToolCall[];
}): UtteranceToolCall[] {
	return utterance.toolCalls.filter((call) => AGENDA_TOOLS.has(call.name));
}

/** All native replayable tool calls an agent utterance carries for cache-preserving conversation history. */
export function replayableCalls(
	utterance: {
		toolCalls: readonly UtteranceToolCall[];
	},
	includeAgency = true,
): UtteranceToolCall[] {
	return utterance.toolCalls.filter(
		(call) =>
			REPLAYABLE.has(call.name) &&
			(includeAgency ||
				(!AGENDA_TOOLS.has(call.name) && !GOAL_TOOLS.has(call.name))),
	);
}
