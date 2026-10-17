import type { Database } from "bun:sqlite";
import type { ExchangeDto } from "../contracts";
import {
	blockedInConversation,
	listExchanges,
	readSummary,
} from "../repository";

/** The two messages of an exchange: the user's and, when one was adopted, the answer. */
type ExchangeRef = {
	inputMessageId: string;
	answerMessageId: string | null;
};

/** What the Window publishes of the history (section 2.4); the unprocessed layer is read from the ledger at each run. */
export type WindowHistory = {
	/** L3: the exchanges kept verbatim, in the order they were appended. */
	keep: ExchangeRef[];
	/** The summary text ("これまでの経緯（要約）"); "" when there is none or it stands on a blocked exchange. */
	summaryText: string;
	/** 0: no summary yet. */
	summaryRevision: number;
	/**
	 * The range of exchanges the summary stands on, by the time the ledger registered them. Absent when there is no
	 * summary text, or none of its source exchanges is in the ledger any more.
	 */
	summaryCovers?: { fromAt: string; toAt: string; turns: number };
	/**
	 * The date range of the exchanges the prompt shows verbatim, as fixed at the last memory step. A rebuild that is
	 * not a step carries it over (the prefix of the prompt must not move between steps). Absent in a window stored
	 * before this field existed; `{}` when there was no exchange at the step.
	 */
	boundary?: HistoryBoundary;
};
export type HistoryBoundary = { fromAt?: string; toAt?: string };

/** How an exchange reaches the prompt (the table of section 2.3). */
type VerbatimClass = "keep" | "unprocessed" | "gone";

function verbatimClass(row: ExchangeDto): VerbatimClass {
	switch (row.disposition) {
		case "keep":
			return "keep";
		case "drop":
			return "gone";
		case "summarize":
			// Not out of the prompt until the summary holds it; a skipped summary must not lose it.
			if (row.summarized === "done") return "gone";
			return row.summarized === "skipped" ? "keep" : "unprocessed";
		default:
			// Before the dispose step, or the dispose step was skipped.
			return "unprocessed";
	}
}

const ref = (row: ExchangeDto): ExchangeRef => ({
	inputMessageId: row.inputMessageId,
	answerMessageId: row.answerMessageId,
});

/** An exchange touching a blocked message is never shown (a forget blocks both sides). */
const isBlockedRow = (blocked: ReadonlySet<string>, row: ExchangeDto) =>
	blocked.has(row.inputMessageId) ||
	(row.answerMessageId !== null && blocked.has(row.answerMessageId));

/** How many of the newest exchanges the prompt always carries (section 2.4). */
const LATEST_EXCHANGES = 2;

/** The exchanges the next prompt shows verbatim: not out of it yet, and the newest ones whatever the steward decided. */
function shownRows(rows: readonly ExchangeDto[]): ExchangeDto[] {
	const newest = new Set(rows.slice(-LATEST_EXCHANGES));
	return rows.filter((row) => verbatimClass(row) !== "gone" || newest.has(row));
}

/** The date range of the verbatim exchanges now (the ledger orders them oldest first). */
function currentBoundary(rows: readonly ExchangeDto[]): HistoryBoundary {
	const shown = shownRows(rows);
	const first = shown[0];
	const last = shown[shown.length - 1];
	return first && last ? { fromAt: first.createdAt, toAt: last.createdAt } : {};
}

/**
 * The history to publish: kept exchanges appended to the earlier list, the summary, and the boundary. The boundary
 * is read from the ledger at a memory step (`step`) or when there is none to carry over; otherwise it stays.
 */
export function buildHistory(
	db: Database,
	conversationId: string,
	previous: WindowHistory | undefined,
	step: boolean,
): WindowHistory {
	const blocked = new Set(blockedInConversation(db, conversationId));
	const live = listExchanges(db, conversationId).filter(
		(row) => !isBlockedRow(blocked, row),
	);
	const keeping = live.filter((row) => verbatimClass(row) === "keep");
	const byInput = new Map(keeping.map((row) => [row.inputMessageId, row]));
	const kept = (previous?.keep ?? []).flatMap((entry) => {
		const row = byInput.get(entry.inputMessageId);
		return row ? [ref(row)] : [];
	});
	const had = new Set(kept.map((entry) => entry.inputMessageId));
	const added = keeping.filter((row) => !had.has(row.inputMessageId)).map(ref);
	const summary = readSummary(db, conversationId);
	const summaryText =
		summary && !summary.sources.some((id) => blocked.has(id))
			? summary.text
			: "";
	const sourceIds = new Set(summaryText === "" ? [] : summary?.sources);
	const sourceRows = live.filter((row) => sourceIds.has(row.inputMessageId));
	const firstSource = sourceRows[0];
	const lastSource = sourceRows[sourceRows.length - 1];
	return {
		keep: [...kept, ...added],
		summaryText,
		summaryRevision: summary?.revision ?? 0,
		...(firstSource && lastSource
			? {
					summaryCovers: {
						fromAt: firstSource.createdAt,
						toAt: lastSource.createdAt,
						turns: sourceRows.length,
					},
				}
			: {}),
		boundary:
			step || !previous?.boundary ? currentBoundary(live) : previous.boundary,
	};
}

/** The verbatim part of a prompt as the ledger and the window say it is now. */
export type VerbatimHistory = {
	/** L3, in the window's order. */
	keep: ExchangeRef[];
	/** Verbatim because no step has taken them out yet, oldest first. */
	unprocessed: ExchangeRef[];
	/** Input message ids of every exchange in the ledger (the others are runs the ledger never took). */
	known: Set<string>;
	/** Every blocked message of the conversation. */
	blocked: Set<string>;
};

export function verbatimHistory(
	db: Database,
	conversationId: string,
	history: WindowHistory | null,
): VerbatimHistory {
	const blocked = new Set(blockedInConversation(db, conversationId));
	const rows = listExchanges(db, conversationId);
	const live = new Map(
		rows
			.filter((row) => !isBlockedRow(blocked, row))
			.map((row) => [row.inputMessageId, row]),
	);
	const keep = (history?.keep ?? []).flatMap((entry) => {
		const row = live.get(entry.inputMessageId);
		return row && verbatimClass(row) === "keep" ? [ref(row)] : [];
	});
	const kept = new Set(keep.map((entry) => entry.inputMessageId));
	const unprocessed = [...live.values()]
		.filter(
			(row) => !kept.has(row.inputMessageId) && verbatimClass(row) !== "gone",
		)
		.map(ref);
	return {
		keep,
		unprocessed,
		known: new Set(rows.map((row) => row.inputMessageId)),
		blocked,
	};
}

/**
 * The messages the next prompt will show verbatim: what the recall of earlier exchanges must not repeat.
 * The newest exchanges count whatever the steward decided about them.
 */
export function verbatimMessageIds(
	db: Database,
	conversationId: string,
): string[] {
	const blocked = new Set(blockedInConversation(db, conversationId));
	const rows = listExchanges(db, conversationId).filter(
		(row) => !isBlockedRow(blocked, row),
	);
	return shownRows(rows).flatMap((row) =>
		row.answerMessageId
			? [row.inputMessageId, row.answerMessageId]
			: [row.inputMessageId],
	);
}
