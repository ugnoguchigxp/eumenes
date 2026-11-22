import type { Database } from "bun:sqlite";
import type { ConversationState, Utterance } from "../../conversation";
import type { Run } from "../contracts";
import { liveSession, markReported, unreportedEnded } from "../repository";
import type { DialogueDeps } from "./context";
import { taskForWork } from "./task-work";
import { workContextCurrent } from "./work-context-input";
import type { DocumentRefs, TodoItem } from "./work-items";
import { INPUT_HEADINGS, gapText, jstNowLine, lineText } from "./input-text";
import {
	screenLinesInTransaction,
	type ResourceContextLine,
} from "./resource-context";
import {
	attachedLinesInTransaction,
	SHARED_LINES,
	sharedLinesInTransaction,
} from "./shared-files";

/** Bounds of the host's fields of `## State` (the conversation input specification, section 7.1). */
export const STATE_LIMITS = {
	work: 8,
	presented: 4,
	/** The conversation's shared files not presented (spec/server-scratch-cache-design-2026-11-07.md §8.1). */
	shared: SHARED_LINES,
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
export function madeOf(
	todo: TodoItem,
	refs: DocumentRefs,
	visible?: Set<string>,
): string[] {
	return (todo.links ?? []).flatMap((link) => {
		const ref = refs.resource(link.uri);
		if (!ref) return [];
		visible?.add(ref);
		return [`${ref}「${lineText(link.label)}」`];
	});
}

function todoLine(todo: TodoItem, made: string[], archived: boolean): string {
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
	/** The same frozen screen projection that normal talk receives. */
	screenLines?: readonly ResourceContextLine[];
	/** Use an empty list when the caller appends the agency section with its own provenance. */
	agencyLines?: readonly string[];
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
};

/** The host's and the model's fields of `## State`, without its heading. */
export function stateLinesInTransaction(
	deps: DialogueDeps,
	tx: Database,
	input: StateInput,
): string[] {
	return stateProjectionInTransaction(deps, tx, input).lines;
}

/** Keep the callable references with the host records that produced the visible lines. */
export function stateProjectionInTransaction(
	deps: DialogueDeps,
	tx: Database,
	input: StateInput,
) {
	const { refs } = input;
	const lines: string[] = [];
	const resources = new Set<string>();
	const todos: number[] = [];
	const gap =
		input.lastAt !== null && input.nowMs - input.lastAt >= STATE_LIMITS.gapMs
			? `（前の発言から${gapText(input.nowMs - input.lastAt)}）`
			: "";
	lines.push(`今: ${jstNowLine(input.nowMs)}${gap}`);

	lines.push(
		...(input.agencyLines ?? agencyStateLines(deps, tx, input.conversationId)),
	);
	const ledger = deps.work;
	const open = (
		ledger?.todosInTransaction(tx, input.conversationId) ?? []
	).filter((todo) =>
		workContextCurrent(deps, tx, input.conversationId, todo.id),
	);
	let briefs = 0;
	const showTodo = (todo: TodoItem, archived: boolean) => {
		todos.push(todo.ref);
		const line = todoLine(todo, madeOf(todo, refs, resources), archived);
		if (
			!input.run ||
			!["manual", "voice"].includes(input.run.sourceKind) ||
			briefs >= 5 ||
			!ledger
		)
			return line;
		const row = ledger.workInTransaction(tx, todo.id);
		const view =
			row?.execution === "task" && row.sourceRef
				? taskForWork(deps, tx, row)?.viewInTransaction(tx, row.sourceRef)
				: null;
		if (view?.conversationSummary !== "next_turn" || !view.progress)
			return line;
		briefs++;
		const { summary, observedAt } = view.progress;
		return `${line} ${JSON.stringify({
			status: view.status,
			revision: view.revision,
			observedAt,
			summary: lineText(summary).slice(0, 320),
		})}`;
	};
	const work = (
		ledger?.pendingConfirmationsInTransaction(tx, input.conversationId) ?? []
	).map(
		(c) =>
			`- c${c.ref} 確認待ち ${c.toolchain}「${lineText(c.request)}」${c.target ? ` 対象「${lineText(c.target)}」` : ""}（${IMPACTS[c.impact] ?? c.impact}）`,
	);
	work.push(
		...open
			.slice(0, Math.max(0, STATE_LIMITS.work - work.length))
			.map((todo) => showTodo(todo, false)),
		...specialistLines(deps, tx, input.conversationId, !!input.run),
		...(input.handoff ? [`- ${lineText(input.handoff)}`] : []),
	);
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
				.filter((todo) =>
					workContextCurrent(deps, tx, input.conversationId, todo.id),
				)
				.map((todo) => showTodo(todo, true)),
		);
	if (work.length) lines.push("仕事:", ...work.slice(0, STATE_LIMITS.work));

	const appendResources = (heading: string, rows: ResourceContextLine[]) => {
		if (!rows.length) return;
		lines.push(heading);
		for (const row of rows) {
			lines.push(row.text);
			if (row.resource) resources.add(row.resource);
		}
	};
	const presented = presentedLines(deps, tx, input, open).slice(
		0,
		STATE_LIMITS.presented,
	);
	appendResources("提示中:", presented);
	if (input.run) {
		const shown = new Set(presented.flatMap(({ resource }) => resource ?? []));
		appendResources(
			"共有中:",
			sharedLinesInTransaction(deps, tx, input.conversationId, shown),
		);
	}
	return { lines, resources: [...resources], todos };
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
): ResourceContextLine[] {
	const { refs } = input;
	const lines = input.run
		? [...(input.screenLines ?? screenLinesInTransaction(deps, tx, input.run))]
		: [];
	const shown = new Set(lines.flatMap(({ resource }) => resource ?? []));
	if (input.run) {
		// The input's own attachments and long paste (§8.1).
		lines.push(
			...attachedLinesInTransaction(deps, tx, input.run.inputMessageId, shown),
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
		if (shown.has(ref)) continue;
		shown.add(ref);
		const full = `${ref}「${lineText(row.label)}」`;
		lines.push({
			resource: ref,
			text: `- ${named.has(full) ? ref : full}（直前の返事で示した）`,
		});
	}
	return lines;
}

/** `## State` as the input shows it. */
export function stateText(lines: readonly string[]): string {
	return `${INPUT_HEADINGS.state}\n${lines.join("\n")}`;
}

/** The settled agency state, bounded and escaped as reference data. */
export function agencyStateLines(
	deps: DialogueDeps,
	db: Database,
	id: string,
): string[] {
	const lines = deps.agency?.stateForContextInTransaction?.(db, id) ?? [];
	return lines.length
		? [
				"あなた自身の関心・問い（資料）:",
				...lines.slice(0, 8).map((line) => `- ${lineText(line)}`),
			]
		: [];
}
