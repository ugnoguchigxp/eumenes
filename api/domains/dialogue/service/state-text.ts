import type { Database } from "bun:sqlite";
import type { ConversationState, Utterance } from "../../conversation";
import type { Run } from "../contracts";
import { liveSession, markReported, unreportedEnded } from "../repository";
import type { DialogueDeps } from "./context";
import type { DocumentRefs, TodoItem } from "./work-items";
import { INPUT_HEADINGS, gapText, jstNowLine, lineText } from "./input-text";
import { viewingLineInTransaction } from "./resource-context";
import { viewedSpecialistTarget } from "./specialist-context";

/** Bounds of the host's fields of `## State` (the conversation input specification, section 7.1). */
export const STATE_LIMITS = {
	work: 8,
	presented: 4,
	/** A TODO archived this long ago is no longer named (its notice told the user it finished). */
	archivedMs: 2 * 60 * 60 * 1000,
	/** A gap this long since the last utterance is said in the `今` line. */
	gapMs: 30 * 60 * 1000,
} as const;

const OUTCOMES: Record<string, string> = {
	partial: "一部のみ",
	failed: "失敗",
	interrupted: "中断",
};
const IMPACTS: Record<string, string> = {
	none: "影響なし",
	create: "作成",
	modify_existing: "変更",
	irreversible: "取り消せない",
};

/** The resources a TODO made, as `a<n>「label」`. */
export function madeOf(todo: TodoItem, refs: DocumentRefs): string[] {
	return (todo.links ?? []).flatMap((link) => {
		const ref = refs.resource(link.uri);
		return ref ? [`${ref}「${lineText(link.label)}」`] : [];
	});
}

function todoLine(
	todo: TodoItem,
	refs: DocumentRefs,
	archived: boolean,
): string {
	const made = madeOf(todo, refs);
	// Finished work is archived as it finishes and told by a notice on screen; work the user cancelled has none.
	const status = archived
		? todo.outcome === "cancelled"
			? "取消済み"
			: "通知済み"
		: todo.status === "waiting"
			? "質問待ち"
			: "実行中";
	const outcome =
		archived && todo.outcome && OUTCOMES[todo.outcome]
			? `（${OUTCOMES[todo.outcome]}）`
			: "";
	return `- t${todo.ref} ${lineText(todo.title)} ${status}${outcome}${made.length ? ` ${made.join(" ")}` : ""}`;
}

/** What the host knows of a specialist's work: a suspended one, a switch waiting for the user, one that ended. */
function specialistLines(
	deps: DialogueDeps,
	tx: Database,
	conversationId: string,
	consume: boolean,
): string[] {
	const port = deps.specialist;
	if (!port) return [];
	const lines: string[] = [];
	const live = liveSession(tx, conversationId);
	if (live?.state === "suspended") {
		const work = port.workStateInTransaction(tx, live.adapterRef, live.workRef);
		const notes = [
			work?.dirty ? "未保存" : null,
			live.expiresAt ? `${jstNowLine(Date.parse(live.expiresAt))}まで` : null,
			live.pendingSwitch ? "別の作業への切替の確認待ち" : null,
		].filter((note): note is string => !!note);
		lines.push(
			`- 担当との作業 ${lineText(live.title)}「${lineText(work?.label ?? live.label ?? "")}」保留中${notes.length ? `（${notes.join("、")}）` : ""}`,
		);
	}
	if (consume) {
		const ended = unreportedEnded(tx, conversationId);
		if (ended) {
			lines.push(
				`- 担当との作業 ${lineText(ended.title)}「${lineText(ended.label ?? "")}」終了（${lineText(ended.endReason ?? "")}）`,
			);
			markReported(tx, conversationId);
		}
	}
	return lines;
}

export type StateInput = {
	conversationId: string;
	/** The run being prepared; absent for a background call, which shows no screen and consumes nothing. */
	run?: Run;
	nowMs: number;
	/** When the newest utterance before this input was said. */
	lastAt: number | null;
	/** When the recent conversation begins: work finished before it is no part of this input (C4). */
	since?: number | null;
	/** The agent's newest utterance in the recent conversation. */
	lastAgent: Utterance | null;
	state: ConversationState | null;
	/** A specialist handed the user's words back (its line names it). */
	handoff?: string;
	refs: DocumentRefs;
	/** The context keeper's view: the model's items carry the numbers it names them by (`d<n>`, `o<n>`, `r<n>`). */
	numbered?: boolean;
};

/** The host's and the model's fields of `## State`, without its heading. */
export function stateLinesInTransaction(
	deps: DialogueDeps,
	tx: Database,
	input: StateInput,
): string[] {
	const { refs } = input;
	const lines: string[] = [];
	const gap =
		input.lastAt !== null && input.nowMs - input.lastAt >= STATE_LIMITS.gapMs
			? `（前の発言から${gapText(input.nowMs - input.lastAt)}）`
			: "";
	lines.push(`今: ${jstNowLine(input.nowMs)}${gap}`);

	const ledger = deps.work;
	const open = ledger?.todosInTransaction(tx, input.conversationId) ?? [];
	const work = [
		...open.map((todo) => todoLine(todo, refs, false)),
		...(
			ledger?.pendingConfirmationsInTransaction(tx, input.conversationId) ?? []
		).map(
			(c) =>
				`- c${c.ref} 確認待ち ${c.toolchain}「${lineText(c.request)}」（${IMPACTS[c.impact] ?? c.impact}）`,
		),
		...specialistLines(deps, tx, input.conversationId, !!input.run),
		...(input.handoff ? [`- ${lineText(input.handoff)}`] : []),
	];
	const room = STATE_LIMITS.work - work.length;
	if (ledger && room > 0)
		work.push(
			...ledger
				.recentlyArchivedInTransaction(
					tx,
					input.conversationId,
					new Date(
						Math.max(
							input.nowMs - STATE_LIMITS.archivedMs,
							input.since ?? Number.NEGATIVE_INFINITY,
						),
					).toISOString(),
					room,
				)
				.map((todo) => todoLine(todo, refs, true)),
		);
	if (work.length) lines.push("仕事:", ...work.slice(0, STATE_LIMITS.work));

	const presented = presentedLines(deps, tx, input, open);
	if (presented.length)
		lines.push("提示中:", ...presented.slice(0, STATE_LIMITS.presented));

	// The context keeper's fields, only while it runs (it is off for now: the review fixes design C5).
	const body = deps.contextKeeper ? input.state?.body : undefined;
	if (body?.topic) lines.push(`話題: ${lineText(body.topic)}`);
	const items = (
		label: string,
		prefix: string,
		list: ReadonlyArray<{ text: string }>,
	) => {
		if (list.length)
			lines.push(
				`${label}:`,
				...list.map(
					(item, i) =>
						`- ${input.numbered ? `${prefix}${i + 1} ` : ""}${lineText(item.text)}`,
				),
			);
	};
	if (body) {
		items("決まったこと", "d", body.decisions);
		items("未解決", "o", body.open);
		items("関係する記録", "r", body.records);
	}
	return lines;
}

/**
 * What is in front of the user: the item on screen, and the resources the agent's newest reply showed. Drawn by
 * fixed rules from the records, never by the model.
 */
function presentedLines(
	deps: DialogueDeps,
	tx: Database,
	input: StateInput,
	open: readonly TodoItem[],
): string[] {
	const { refs } = input;
	const lines: string[] = [];
	if (input.run) {
		const viewing = viewingLineInTransaction(deps, tx, input.run);
		if (viewing) lines.push(`- ${lineText(viewing)}（画面に表示中）`);
		const target = viewedSpecialistTarget(deps, tx, input.run);
		if (target)
			lines.push(
				`- ${lineText(target.specialist)}「${lineText(target.label)}」（画面に表示中、target ${target.ref}）`,
			);
	}
	const message = input.lastAgent?.messageId
		? deps.conversation.messageInTransaction(tx, input.lastAgent.messageId)
				?.message
		: undefined;
	if (!message) return lines;
	const named = new Set(open.flatMap((todo) => madeOf(todo, refs)));
	for (const row of deps.resourceLedger?.ofMessageInTransaction(
		tx,
		message.id,
	) ?? []) {
		const ref = `a${row.ref}`;
		const full = `${ref}「${lineText(row.label)}」`;
		lines.push(`- ${named.has(full) ? ref : full}（直前の返事で示した）`);
	}
	return lines;
}

/**
 * The resources (`a<n>`) the lines of `## State` name, in order: the only ones a choice may hand over. A label in
 * 「」 is the resource's own words, not a reference.
 */
export function namedResources(lines: readonly string[]): string[] {
	const named = new Set<string>();
	for (const line of lines)
		for (const [ref] of line
			.replace(/「[^」]*」/g, "")
			.matchAll(/(?<![\p{L}\p{N}_])a\d+(?!\p{N})/gu))
			named.add(ref);
	return [...named];
}

/** `## State` as the input shows it. */
export function stateText(lines: readonly string[]): string {
	return `${INPUT_HEADINGS.state}\n${lines.join("\n")}`;
}
