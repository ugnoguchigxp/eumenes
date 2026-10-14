import type { Database } from "bun:sqlite";
import type {
	BlockerReason,
	KanbanBoardView,
	KanbanCardActionName,
	KanbanCardView,
	KanbanRunView,
	KanbanViewContext,
} from "./contracts";
import { allCards, boardRevision, getCard, type CardRow } from "./repository";
import {
	boardRuns,
	getQueue,
	getRun,
	latestHandedRuns,
	waitingCount,
	handedRuns,
	type RunRow,
} from "./runs-repository";

const iso = (ms: number) => new Date(ms).toISOString();

/** Blocker reasons of a run that never reached Claude Code: there is no session to show. */
const NOT_SENT: readonly BlockerReason[] = ["cancelled", "send_failed"];
/** Blocker reasons after which the conversation cannot be continued (run again instead). */
const NO_FOLLOWUP: readonly BlockerReason[] = [
	...NOT_SENT,
	"resume_failed",
	"tracking_lost",
];

/** The card has a conversation that a follow-up or a commit can continue. */
export const hasConversation = (
	card: Pick<CardRow, "claudeSessionId" | "label" | "reason">,
): boolean =>
	card.claudeSessionId !== null &&
	!(
		card.label === "blocker" &&
		card.reason &&
		NO_FOLLOWUP.includes(card.reason)
	);

/**
 * The actions allowed now, decided from the column, label and current run (business rule, plan
 * §3.8). Run actions need a host that can track runs. A running card waiting for its turn can
 * only be cancelled; once handed over it can be stopped or opened (the application turns the stop
 * into a cancel while the terminals request is still unsent).
 */
export function cardActions(
	card: Pick<
		CardRow,
		"column" | "label" | "reason" | "claudeSessionId" | "reviewed"
	>,
	view: KanbanViewContext,
	currentRun?: Pick<RunRow, "state"> | null,
): KanbanCardActionName[] {
	if (card.column === "running")
		return currentRun?.state === "waiting_turn" ? ["cancel"] : ["stop", "open"];
	const actions: KanbanCardActionName[] = ["edit", "remove"];
	if (view.runnable) actions.push("run");
	if (card.column === "todo") return actions;
	if (view.runnable && hasConversation(card)) actions.push("followup");
	if (card.label === "done") {
		if (view.runnable && card.claudeSessionId) actions.push("commitPush");
		if (!card.reviewed) actions.push("review");
	}
	actions.push("reset");
	// The Claude Code screen shows a session only when the last run reached one.
	if (card.claudeSessionId && !(card.reason && NOT_SENT.includes(card.reason)))
		actions.push("open");
	return actions;
}

function cardView(
	card: CardRow,
	view: KanbanViewContext,
	currentRun: RunRow | null,
	followed: boolean,
): KanbanCardView {
	return {
		id: card.id,
		revision: card.revision,
		title: card.title,
		prompt: card.prompt,
		column: card.column,
		...(card.label ? { label: card.label } : {}),
		...(card.reason ? { reason: card.reason } : {}),
		reviewed: card.reviewed,
		commitPushReported: card.commitPushReported,
		followedByOtherRun: followed,
		projectId: card.projectId,
		...(card.claudeSessionId ? { claudeSessionId: card.claudeSessionId } : {}),
		...(card.currentRunId ? { currentRunId: card.currentRunId } : {}),
		...(card.lastReport ? { lastReport: card.lastReport } : {}),
		files: card.files,
		position: card.position,
		actions: cardActions(card, view, currentRun),
		createdAt: iso(card.createdAt),
		updatedAt: iso(card.updatedAt),
	};
}

/** Whether another card's run was handed over after the card's last run (changes may mix). */
function followedBy(latest: ReturnType<typeof latestHandedRuns>) {
	return (card: CardRow, run: RunRow | null): boolean => {
		if (card.label !== "done" || card.commitPushReported || run === null)
			return false;
		const other = latest.find((item) => item.cardId !== card.id);
		return other !== undefined && other.seq > run.seq;
	};
}

function runView(run: RunRow): KanbanRunView {
	return {
		id: run.id,
		cardId: run.cardId,
		kind: run.kind,
		state: run.state,
		...(run.reason ? { reason: run.reason } : {}),
		cardRevision: run.cardRevision,
		title: run.title,
		prompt: run.prompt,
		claudeSessionId: run.claudeSessionId,
		origin: run.origin,
		createdAt: iso(run.createdAt),
		...(run.finishedAt !== null ? { finishedAt: iso(run.finishedAt) } : {}),
	};
}

export function boardInTransaction(
	tx: Database,
	view: KanbanViewContext,
): KanbanBoardView {
	const runs = boardRuns(tx);
	const byId = new Map(runs.map((run) => [run.id, run]));
	const handed = handedRuns(tx)[0];
	const followed = followedBy(latestHandedRuns(tx));
	return {
		revision: boardRevision(tx),
		queue: {
			...getQueue(tx),
			waiting: waitingCount(tx),
			...(handed ? { handedRunId: handed.id } : {}),
		},
		runnable: view.runnable,
		cards: allCards(tx).map((card) => {
			const run = card.currentRunId
				? (byId.get(card.currentRunId) ?? null)
				: null;
			return cardView(card, view, run, followed(card, run));
		}),
		runs: runs.map(runView),
	};
}

export function cardInTransaction(
	tx: Database,
	cardId: string,
	view: KanbanViewContext,
): KanbanCardView | null {
	const card = getCard(tx, cardId);
	if (!card) return null;
	const run = card.currentRunId ? getRun(tx, card.currentRunId) : null;
	return cardView(card, view, run, followedBy(latestHandedRuns(tx))(card, run));
}
