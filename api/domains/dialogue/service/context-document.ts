import { estimateTextTokens } from "../../../infrastructure/context-budget";
import { referenceJson } from "../../../infrastructure/reference-json";
import type {
	ContinuityItem,
	ConversationEvent,
	EpisodeSegment,
} from "../../continuity";
import type { ContextBlock } from "../../inference";
import { keepOrder, type ProfileItem } from "../../memory";
import type { WorkLink } from "../contracts/resources";
import { eventFields } from "./event-fields";
import { replaceResourceUrisIn } from "./resource-text";

/**
 * The material document of a generation (the ContextWindow layout specification, sections 2 and 4): four tagged
 * sections, one item per line, from what changes least to what changes most. `<memory>` and `<history>` change only
 * at a re-construction, `<log>` only grows at its end, and the small `<state>` after it is drawn as things are now.
 * The same sources always give the same text. What holds for one call only (`<now>`) is the last message's.
 */
export const DOCUMENT_SECTIONS = ["memory", "history", "log", "state"] as const;
export type DocumentSection = (typeof DOCUMENT_SECTIONS)[number];

/** A TODO as the conversation sees it: a projection of the execution ledger (section 4.4). */
export type TodoItem = {
	id: string;
	/** The conversation's number of the TODO (`t<ref>`). */
	ref: number;
	/** The toolchain the work was handed to. */
	toolchainId?: string;
	/** The resources the finished work made (section 7.1 of the resource plan); absent when none. */
	links?: WorkLink[];
	title: string;
	status: "todo" | "waiting" | "done";
	outcome?: string;
	questionId?: string;
	question?: string;
};

/** A confirmation the host issued before executing a change. */
export type PendingConfirmation = {
	id: string;
	/** The conversation's number of the confirmation (`c<ref>`). */
	ref: number;
	toolchain: string;
	request: string;
	impact: string;
};

/** A resource the conversation has met, as the state section lists it (`a<ref>`, section 7.1 of the resource plan). */
export type ResourceLine = {
	ref: number;
	/** The kind's display name, e.g. 「画像」. */
	kindLabel: string;
	label: string;
	/** The TODO that made it (`t3`), or `履歴 MM-DD` for one found in the history. */
	origin: string;
	/** What can be done with it in words, the kind's default first. */
	actions: readonly string[];
};

/** What the state section is made of: the TODOs, the host's records and the short-term notes. */
export type StateSources = {
	todos: readonly TodoItem[];
	/** The resources, most recently used first (at most `RESOURCE_LINES`). */
	resources?: readonly ResourceLine[];
	pendingConfirmation: readonly PendingConfirmation[];
	retained: ReadonlyArray<{ id: string; summary: string }>;
	/** The memory steward's notes of this conversation (decisions, questions to the user, goals, memos). */
	notes: readonly ContinuityItem[];
	/** The adopted goals of the goals domain. */
	goals: ReadonlyArray<{ id: string; text: string }>;
	/** Long-term items waiting to join the profile. */
	newMemories: readonly ProfileItem[];
};

/** What holds for this generation only (the last message, section 5.1). */
export type NowSources = {
	at: string;
	/** The resource on screen, as a line (`a3 画像「…」`); absent when none. */
	viewing?: string;
	trigger: ReadonlyArray<Record<string, unknown>>;
	/** The event id of the utterance being delivered, if any. */
	speaking: string | null;
	/** What the agency shows besides its own utterances (those are in the log). */
	agency: ReadonlyArray<string>;
	/** Other records of this call the host keeps (a World names hint, a specialist work record). */
	records: readonly ContextBlock[];
};

export type DocumentSources = {
	/** The published profile, in its order. */
	profile: readonly ProfileItem[];
	episode: readonly EpisodeSegment[];
	/** The logged events, in log order. */
	log: readonly ConversationEvent[];
	state: StateSources;
};

/** The numbers the model reads host records by (section 6): a TODO's `t<ref>`, a confirmation's `c<ref>`. */
export type DocumentRefs = {
	todo(id: string): string | null;
	confirmation(id: string): string | null;
	/** `a<n>` of a resource URI in the conversation's ledger; null when it is not there. */
	resource(uri: string): string | null;
};

export type RenderedSection = { text: string; tokens: number };
export type ContextDocument = {
	sections: Record<DocumentSection, RenderedSection>;
	/** The whole document: the four tagged sections. */
	text: string;
	tokens: number;
	/** The profile items shown, in order: `p<n>` is `profileIds[n - 1]`. */
	profileIds: string[];
};

/** A gap this long before an event starts a resumed conversation in the log (section 7). */
export const RESUME_LINE_GAP_MS = 30 * 60 * 1000;
/** A result longer than this is not shown in the log: the model reads it with the work tool's check. */
export const RESULT_LINE_MAX_TOKENS = 1500;

const PROFILE_KINDS: Record<string, string> = {
	constraint: "制約",
	preference: "好み",
	personal_fact: "事実",
	habit: "習慣",
	tendency: "傾向",
};
const STATUSES: Record<string, string> = {
	todo: "進行中",
	waiting: "質問待ち",
	done: "完了",
};
const OUTCOMES: Record<string, string> = {
	succeeded: "成功",
	partial: "一部",
	failed: "失敗",
	cancelled: "取消",
	interrupted: "中断",
};
const IMPACTS: Record<string, string> = {
	none: "影響なし",
	create: "作成",
	modify_existing: "変更",
	irreversible: "取り消せない",
};
const MEMORY_REQUESTS: Record<string, string> = {
	forget: "忘れて",
	remember: "覚えて",
	correct: "直して",
	goal: "目標",
	withdraw: "取下げ",
};
const WORK_OPERATIONS: Record<string, string> = {
	answer: "回答",
	amend: "訂正",
	cancel: "取消",
};

/**
 * Text from outside (the user's words, a sub-agent's result, a page) on one line: `<` and `>` become full-width so
 * it can not forge a section tag, and line breaks (U+0085, U+2028 and U+2029 included) become `⏎` so it can not forge
 * a line.
 */
export function plain(text: string): string {
	return text
		.replace(/</g, "＜")
		.replace(/>/g, "＞")
		.replace(/\r\n|[\r\n\u0085\u2028\u2029]/g, "⏎");
}

const str = (value: unknown) => (typeof value === "string" ? value : "");
/** `MM-DD` of a time or day (`YYYY-MM-DD…`), with the year when it is not `year`. */
export const dayOf = (at: string, year: string) =>
	at.slice(0, 4) === year ? at.slice(5, 10) : at.slice(0, 10);
const minuteOf = (at: string) => at.slice(11, 16);

function gapText(ms: number): string {
	const minutes = Math.round(ms / 60_000);
	if (minutes < 60) return `${minutes}分`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}時間`;
	return `${Math.round(hours / 24)}日`;
}

function profileLine(item: ProfileItem, n: number): string {
	const notes = [
		...(item.negated ? ["否定"] : []),
		item.source === "user_said" ? "本人の発言" : "傾向",
		...(item.since || item.until
			? [`${item.since ?? ""}〜${item.until ?? ""}`]
			: []),
	];
	return `p${n} ${PROFILE_KINDS[item.kind] ?? item.kind} ${plain(item.text)} (${notes.join(", ")})`;
}

/** The profile within its budget: kept in keep order, shown in published order. */
export function fitProfile(
	items: readonly ProfileItem[],
	limit: number,
): ProfileItem[] {
	const kept = new Set<string>();
	let used = 0;
	for (const item of keepOrder(items)) {
		const tokens = estimateTextTokens(profileLine(item, 99)) + 1;
		if (used + tokens > limit) continue;
		kept.add(item.id);
		used += tokens;
	}
	return items.filter((item) => kept.has(item.id));
}

function historyLine(segment: EpisodeSegment, n: number, year: string) {
	const range = `${dayOf(segment.fromAt, year)}〜${dayOf(segment.toAt, year)}`;
	return segment.kind === "summary"
		? `s${n} ${range} ${plain(segment.text)}`
		: `s${n} ${range} 要約なし（${segment.count}件。会話履歴の担当で読める）`;
}

/** A result as the model reads it: a resource is its number, never its URI (section 2.3 of the resource plan). */
export function hideUris(value: unknown, refs: DocumentRefs): unknown {
	return replaceResourceUrisIn(
		value,
		(uri) => refs.resource(uri) ?? "リソース",
	);
}

function resultLine(
	fields: Record<string, unknown>,
	todo: string,
	refs: DocumentRefs,
): string | null {
	if (fields.status === "waiting")
		return `問い ${todo}: ${plain(str(fields.question))}`;
	const outcome = OUTCOMES[str(fields.outcome)] ?? str(fields.outcome);
	const body = referenceJson(hideUris(fields.result ?? null, refs));
	return estimateTextTokens(body) > RESULT_LINE_MAX_TOKENS
		? `結果 ${todo} ${outcome}: （長いので work の check で読む）`
		: `結果 ${todo} ${outcome}: ${body}`;
}

/** What an action says in the log; null for one that only read (it changed nothing). */
function actedLine(
	fields: Record<string, unknown>,
	refs: DocumentRefs,
): string | null {
	const todo = refs.todo(str(fields.todo)) ?? "";
	switch (fields.action) {
		case "delegate":
			if (fields.instant) return `その場で使った担当 ${str(fields.toolchain)}`;
			return fields.session
				? `担当との作業 ${str(fields.toolchain)}「${plain(str(fields.request))}」`
				: `依頼 ${todo} ${str(fields.toolchain)}「${plain(str(fields.request))}」`;
		case "confirm":
			return `確認を発行 ${refs.confirmation(str(fields.confirmation)) ?? ""} ${str(fields.toolchain)}（${IMPACTS[str(fields.impact)] ?? str(fields.impact)}）`;
		case "memory.request":
			return `記憶の依頼 ${MEMORY_REQUESTS[str(fields.kind)] ?? str(fields.kind)}`;
		case "memory.notice":
			return `記憶の依頼の結果: ${plain(str(fields.text))}`;
		case "work.answer":
		case "work.amend":
		case "work.cancel": {
			const operation = str(fields.action).slice("work.".length);
			const text = str(fields.text);
			return `仕事の操作 ${todo} ${WORK_OPERATIONS[operation]}${text ? `「${plain(text)}」` : ""}`;
		}
		case "work.result":
			return resultLine(fields, todo, refs);
		case "work.archived":
			return `伝達済み ${todo}`;
		case "find_toolchain":
		case "memory.read":
		case "work.check":
		case "work.archive_unconfirmed":
			return null;
		default:
			return `行動 ${str(fields.action)}`;
	}
}

const AGENT_ORIGINS: Record<string, string> = {
	announcement: "自分（予告）",
	spontaneous: "自分（自分から）",
	confirmation: "自分（確認）",
};

/** An event as one line of the log (section 4.3), or null when it adds nothing the conversation needs. */
export function eventLine(
	event: ConversationEvent,
	refs: DocumentRefs,
): string | null {
	const head = `${event.id} ${minuteOf(event.at)}`;
	if (event.forgotten) return `${head} （忘れた出来事）`;
	const fields = eventFields(event);
	let body: string | null;
	switch (event.type) {
		case "said": {
			const text = `${plain(str(fields.text))}${fields.textCut ? "…（続きは省略）" : ""}`;
			if (event.by === "user")
				body = `${fields.origin === "schedule" ? "利用者（予約の発言）" : fields.to === "specialist" ? "利用者（担当へ）" : "利用者"}: ${text}`;
			else if (event.by === "specialist")
				body = `担当 ${str(fields.toolchain)}: ${text}`;
			else {
				const told = Array.isArray(fields.todoRefs)
					? fields.todoRefs
							.map((id) => refs.todo(str(id)))
							.filter((ref): ref is string => !!ref)
					: [];
				body = `${AGENT_ORIGINS[str(fields.origin)] ?? "自分"}: ${text}${told.length ? ` [伝えた: ${told.join(" ")}]` : ""}`;
			}
			break;
		}
		case "delivered":
			body =
				fields.heard === "full"
					? null
					: fields.heard === "partial"
						? `届かず ${str(fields.ref)} 途中まで「${plain(str(fields.deliveredText))}」`
						: `届かず ${str(fields.ref)}`;
			break;
		case "acted":
			body = actedLine(fields, refs);
			break;
		case "notice":
			body = `通知 ${plain(str(fields.text) || str(fields.kind))}`;
			break;
		default:
			body = null;
	}
	return body === null ? null : `${head} ${body}`;
}

function logLines(
	log: readonly ConversationEvent[],
	refs: DocumentRefs,
	year: string,
): string[] {
	const lines: string[] = [];
	let day = "";
	let lastMs: number | null = null;
	for (const event of log) {
		const line = eventLine(event, refs);
		if (line === null) continue;
		const at = Date.parse(event.at);
		if (lastMs !== null && at - lastMs >= RESUME_LINE_GAP_MS)
			lines.push(
				`--- 再開 ${dayOf(event.at, year)} ${minuteOf(event.at)}（前回から${gapText(at - lastMs)}）---`,
			);
		const eventDay = dayOf(event.at, year);
		if (eventDay !== day) {
			lines.push(eventDay);
			day = eventDay;
		}
		lines.push(line);
		lastMs = lastMs === null ? at : Math.max(lastMs, at);
	}
	return lines;
}

const NOTE_LINES: Record<string, { prefix: string; label: string }> = {
	open_question: { prefix: "q", label: "問い" },
	decision: { prefix: "m", label: "決定" },
	memo: { prefix: "m", label: "メモ" },
	goal: { prefix: "g", label: "目標" },
};

function stateLines(
	state: StateSources,
	log: readonly ConversationEvent[],
	refs: DocumentRefs,
	year: string,
): string[] {
	// The newest result event of each TODO the log shows.
	const resultOf = new Map<string, string>();
	for (const event of log) {
		if (event.type !== "acted" || event.forgotten) continue;
		const fields = eventFields(event);
		if (fields.action === "work.result" && typeof fields.todo === "string")
			resultOf.set(fields.todo, event.id);
	}
	const lines: string[] = [];
	for (const todo of state.todos) {
		const made = (todo.links ?? []).flatMap(
			(link) => refs.resource(link.uri) ?? [],
		);
		const head = `t${todo.ref} ${STATUSES[todo.status]} ${plain(todo.title)}`;
		if (todo.status === "waiting")
			lines.push(`${head} 問い: ${plain(todo.question ?? "")}`);
		else if (todo.status === "done") {
			const result = resultOf.get(todo.id);
			// A result the log no longer shows (moved out by a re-construction) is read with the work tool.
			lines.push(
				`${head} (${[OUTCOMES[todo.outcome ?? ""] ?? todo.outcome, result ? `結果 ${result}` : "結果は work の check で読む", "未伝達"].join(", ")})`,
			);
		} else lines.push(head);
		if (made.length) lines[lines.length - 1] += ` → ${made.join(" ")}`;
	}
	for (const confirmation of state.pendingConfirmation)
		lines.push(
			`c${confirmation.ref} 確認待ち ${confirmation.toolchain}「${plain(confirmation.request)}」(${IMPACTS[confirmation.impact] ?? confirmation.impact})`,
		);
	const counts: Record<string, number> = {};
	const numbered = (prefix: string) => {
		counts[prefix] = (counts[prefix] ?? 0) + 1;
		return `${prefix}${counts[prefix]}`;
	};
	for (const note of state.notes) {
		const kind = NOTE_LINES[note.kind];
		if (!kind) continue;
		const until = note.expiresAt
			? ` (〜${dayOf(new Date(Date.parse(note.expiresAt) + 9 * 3_600_000).toISOString(), year)})`
			: "";
		lines.push(
			`${numbered(kind.prefix)} ${kind.label} ${plain(note.text)}${until}`,
		);
	}
	for (const goal of state.goals)
		lines.push(`${numbered("g")} 目標 ${plain(goal.text)}`);
	state.newMemories.forEach((item, i) =>
		lines.push(
			`n${i + 1} 反映待ちの記憶 ${PROFILE_KINDS[item.kind] ?? item.kind} ${plain(item.text)} (${item.source === "user_said" ? "本人の発言" : "傾向"})`,
		),
	);
	for (const resource of state.resources ?? [])
		lines.push(
			`a${resource.ref} ${resource.kindLabel}「${plain(resource.label)}」(${resource.origin}) ${resource.actions.join("・")}`,
		);
	for (const toolchain of state.retained)
		lines.push(`担当 ${toolchain.id} ${plain(toolchain.summary)}`);
	return lines;
}

/** A section: its tag lines around its items. An empty one is the two tags alone, so a first item only appends. */
const tagged = (name: string, lines: readonly string[]): RenderedSection => {
	const text = [`<${name}>`, ...lines, `</${name}>`].join("\n");
	return { text, tokens: estimateTextTokens(text) };
};

/**
 * Renders the document. The profile is fitted to `profileLimit`; every other section is rendered as given (the
 * re-construction and the caller keep them inside their budgets). `year` is the current year: dates of that year
 * are written without it.
 */
export function renderDocument(
	sources: DocumentSources,
	options: { profileLimit: number; refs: DocumentRefs; year: string },
): ContextDocument {
	const { refs, year } = options;
	const profile = fitProfile(sources.profile, options.profileLimit);
	const sections: Record<DocumentSection, RenderedSection> = {
		memory: tagged(
			"memory",
			profile.map((item, i) => profileLine(item, i + 1)),
		),
		history: tagged(
			"history",
			sources.episode.map((segment, i) => historyLine(segment, i + 1, year)),
		),
		log: tagged("log", logLines(sources.log, refs, year)),
		state: tagged("state", stateLines(sources.state, sources.log, refs, year)),
	};
	const text = DOCUMENT_SECTIONS.map((key) => sections[key].text).join("\n");
	return {
		sections,
		text,
		tokens: estimateTextTokens(text),
		profileIds: profile.map((item) => item.id),
	};
}

/** The history section alone, for its budget (the re-construction keeps it inside). */
export function historyTokens(
	episode: readonly EpisodeSegment[],
	year: string,
): number {
	return tagged(
		"history",
		episode.map((segment, i) => historyLine(segment, i + 1, year)),
	).tokens;
}

/** A block of this call as `<now>` shows it: its labels, then its data. */
export function blockFields(block: ContextBlock): Record<string, unknown> {
	const body =
		block.body.kind === "json"
			? { data: block.body.value }
			: block.body.kind === "text"
				? { text: block.body.text }
				: {
						...(block.body.header ? { header: block.body.header } : {}),
						sections: block.body.sections,
					};
	return {
		authority: block.authority,
		...(block.certainty ? { certainty: block.certainty } : {}),
		...(block.covers ? { covers: block.covers } : {}),
		...body,
	};
}

function triggerLine(
	trigger: Record<string, unknown>,
	refs: DocumentRefs,
): string {
	switch (trigger.kind) {
		case "not_adopted":
			return "前回の返答は採用されなかった（log と state で、すでにしたことを確かめる）";
		case "host_note":
			return `ホストの知らせ: ${plain(str(trigger.text))}`;
		case "todo_changed": {
			const todos = Array.isArray(trigger.todos)
				? (trigger.todos as Array<Record<string, unknown>>)
				: [];
			return `仕事の変化 ${todos.map((todo) => `${refs.todo(str(todo.id)) ?? ""} ${STATUSES[str(todo.status)] ?? str(todo.status)}`).join(", ")}`;
		}
		case "utterance":
			return `利用者の発言 ${(Array.isArray(trigger.events) ? trigger.events : []).map(str).join(" ")}`;
		default: {
			const { kind, ...rest } = trigger;
			return `${str(kind)}${Object.keys(rest).length ? ` ${referenceJson(rest)}` : ""}`;
		}
	}
}

/** The `<now>` block of the last message: what holds for this call only. */
export function renderNow(now: NowSources, refs: DocumentRefs): string {
	const lines = [
		`時刻 ${now.at.slice(0, 10)} ${now.at.slice(11, 16)}`,
		...now.trigger.map((trigger) => `きっかけ ${triggerLine(trigger, refs)}`),
		`話し中 ${now.speaking ?? "なし"}`,
		...(now.viewing ? [`viewing ${now.viewing}`] : []),
		...now.agency.map((line) => `agency ${plain(line)}`),
		...now.records.map(
			(block) => `資料 ${block.source}: ${referenceJson(blockFields(block))}`,
		),
	];
	return `<now>\n${lines.join("\n")}\n</now>`;
}
