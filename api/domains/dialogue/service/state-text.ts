import type { Database } from "bun:sqlite";
import type { ConversationState, Utterance } from "../../conversation";
import type { Run } from "../contracts";
import { liveSession, markReported, unreportedEnded } from "../repository";
import type { DialogueDeps } from "./context";
import { planGoalLines } from "./state-plans";
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
const STATE_LIMITS = {
	work: 8,
	presented: 4,
	/** The conversation's shared files not presented (spec/server-scratch-cache-design-2026-11-07.md §8.1). */
	shared: SHARED_LINES,
	/** A gap this long since the last utterance is said in the `今` line. */
	gapMs: 30 * 60 * 1000,
} as const;

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
	/** The agent's newest utterance in the recent conversation. */
	lastAgent: Utterance | null;
	state: ConversationState | null;
	/** A specialist handed the user's words back (its line names it). */
	handoff?: string;
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
	const lines: string[] = [];
	const resources = new Set<string>();
	const gap =
		input.lastAt !== null && input.nowMs - input.lastAt >= STATE_LIMITS.gapMs
			? `（前の発言から${gapText(input.nowMs - input.lastAt)}）`
			: "";
	lines.push(`今: ${jstNowLine(input.nowMs)}${gap}`);

	lines.push(
		...(input.agencyLines ?? agencyStateLines(deps, tx, input.conversationId)),
	);
	const work = [
		...specialistLines(deps, tx, input.conversationId, !!input.run),
		...(input.handoff ? [`- ${lineText(input.handoff)}`] : []),
	];
	if (work.length) lines.push("仕事:", ...work.slice(0, STATE_LIMITS.work));

	const appendResources = (heading: string, rows: ResourceContextLine[]) => {
		if (!rows.length) return;
		lines.push(heading);
		for (const row of rows) {
			lines.push(row.text);
			if (row.resource) resources.add(row.resource);
		}
	};
	const presented = presentedLines(deps, tx, input).slice(
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
	lines.push(...planGoalLines(deps, tx));
	return { lines, resources: [...resources] };
}

/**
 * What is in front of the user: the item on screen, and the resources the agent's newest reply showed. Drawn by
 * fixed rules from the records, never by the model.
 */
function presentedLines(
	deps: DialogueDeps,
	tx: Database,
	input: StateInput,
): ResourceContextLine[] {
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
	for (const row of deps.resourceLedger?.ofMessageInTransaction(
		tx,
		message.id,
	) ?? []) {
		const ref = `a${row.ref}`;
		if (shown.has(ref)) continue;
		shown.add(ref);
		lines.push({
			resource: ref,
			text: `- ${ref}「${lineText(row.label)}」（直前の返事で示した）`,
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
