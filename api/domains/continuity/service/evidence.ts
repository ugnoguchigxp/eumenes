import type { Database } from "bun:sqlite";
import {
	QUOTE_MAX,
	type EvidenceExclusion,
	type EvidenceInput,
	type PlanEvidence,
} from "../contracts/plans";
import { sourcesOfOwners } from "../repository/plans";

/** `YYYY-MM-DD`, or with a time (seconds and a zone allowed): the agency package's due format. */
const DUE =
	/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?)?$/u;

export function normalizeEvidence(evidence: EvidenceInput): EvidenceInput {
	const messages = new Map<
		string,
		{ messageId: string; conversationId?: string; quote: string | null }
	>();
	for (const message of evidence.messages) {
		const messageId = message.messageId.trim();
		if (messageId === "") continue;
		const quote = message.quote?.trim() || null;
		if (quote !== null && quote.length > QUOTE_MAX)
			throw new Error("invalid_continuity_evidence");
		if (!messages.has(messageId))
			messages.set(messageId, {
				messageId,
				...(message.conversationId === undefined
					? {}
					: { conversationId: message.conversationId }),
				quote,
			});
	}
	const memoryItemIds = [
		...new Set(
			(evidence.memoryItemIds ?? []).map((id) => id.trim()).filter(Boolean),
		),
	];
	if (messages.size === 0 && memoryItemIds.length === 0)
		throw new Error("invalid_continuity_evidence");
	return { messages: [...messages.values()], memoryItemIds };
}
export function checkText(text: string, max: number): string {
	const trimmed = text.trim();
	if (trimmed === "" || [...trimmed].length > max)
		throw new Error("invalid_plan_text");
	return trimmed;
}
export function checkDue(dueAt: string | null | undefined) {
	if (dueAt !== undefined && dueAt !== null && !DUE.test(dueAt))
		throw new Error("invalid_plan_due");
}
const ZONE = /(?:Z|[+-]\d{2}:\d{2})$/u;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
/**
 * A date as stored: in the user's local time (JST), the form `markDueAwaiting` compares. A date with a zone is
 * converted (`2026-11-25T01:00Z` is `2026-11-25T10:00`); a date alone, or a time without a zone (already local), stays.
 * Seconds stay only when they were written. Call after `checkDue`.
 */
export function localDue<T extends string | null | undefined>(dueAt: T): T {
	if (typeof dueAt !== "string" || !ZONE.test(dueAt)) return dueAt;
	const local = new Date(Date.parse(dueAt) + JST_OFFSET_MS).toISOString();
	const seconds = /T\d{2}:\d{2}:\d{2}/u.test(dueAt);
	return local.slice(0, seconds ? 19 : 16) as T;
}
export const cut = <T>(list: T[], limit: number | undefined) =>
	limit === undefined ? list : list.slice(0, Math.max(0, limit));

/**
 * Drops the entries that rest on a source the exclusion names (an immediate forget whose closure delete
 * has not run yet).
 */
export function createVisibility(
	exclusion: () => EvidenceExclusion | undefined,
) {
	return function visible<
		T extends { evidence: PlanEvidence[]; memoryItemIds: string[] },
	>(db: Database, entries: T[]): T[] {
		const check = exclusion();
		if (!check || entries.length === 0) return entries;
		const excluded = check(db, sourcesOfOwners(entries));
		return entries.filter(
			(entry) =>
				!entry.evidence.some((e) => excluded.messageIds.has(e.messageId)) &&
				!entry.memoryItemIds.some((m) => excluded.memoryItemIds.has(m)),
		);
	};
}
export type Visible = ReturnType<typeof createVisibility>;
