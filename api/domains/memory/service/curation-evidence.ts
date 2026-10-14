import type { Database } from "bun:sqlite";
import { sliceUtf8Range } from "eumenes-memory";
import type { HostSourceState, StateItem } from "eumenes-memory/sqlite";
import type { CurationRejection } from "../contracts";
import { isBlocked } from "../repository";
import {
	MAX_QUOTE_BYTES,
	SOURCE_REPRESENTATION,
	byteLength,
	hostMessageSource,
	refOf,
	type CurationDeps,
	type Evidence,
} from "./curation-shared";
import { evidenceWindow, foldedLength, locateQuoteSpan } from "./quote";
import { parseDatePart } from "./validity";

export type ValidityBounds =
	| null
	| "invalid"
	| {
			from?: NonNullable<ReturnType<typeof parseDatePart>>;
			until?: NonNullable<ReturnType<typeof parseDatePart>>;
			basis: "stated";
	  };

/** `from`/`until` as the model wrote them (`YYYY`, `YYYY-MM`, `YYYY-MM-DD`) in the library's precision-carrying form. */
export function validityBounds(item: {
	validFrom?: string | null;
	validUntil?: string | null;
}): ValidityBounds {
	if (!item.validFrom && !item.validUntil) return null;
	const from = item.validFrom ? parseDatePart(item.validFrom) : undefined;
	const until = item.validUntil ? parseDatePart(item.validUntil) : undefined;
	if (from === null || until === null) return "invalid";
	return {
		...(from ? { from } : {}),
		...(until ? { until } : {}),
		basis: "stated",
	};
}

export function createEvidence(deps: CurationDeps) {
	const { conversation } = deps;
	/** Whether the library holds a tombstone for the message as a source. */
	function sourceTombstoned(db: Database, messageId: string): boolean {
		const key = JSON.stringify([
			"conversation",
			"message",
			messageId,
			SOURCE_REPRESENTATION,
		]);
		return (
			db
				.query(
					"SELECT 1 FROM memory_tombstone WHERE target_type = 'source' AND target_id = ?",
				)
				.get(key) != null
		);
	}

	/**
	 * The evidence of an item written from a user message: the quote's byte range when the model's quote is found in
	 * the message (spaces, punctuation and width forms forgiven), else the message itself (its best window when it is
	 * longer than the library keeps). Never the assistant's words, never a blocked message.
	 */
	function evidenceFrom(
		db: Database,
		conversationId: string,
		messageId: string,
		quote: string | null | undefined,
		hint: string,
	):
		| {
				ok: true;
				evidence: Evidence;
				source: HostSourceState;
				quoteMatched: boolean;
				runId: string | null;
		  }
		| { ok: false; reason: CurationRejection } {
		const found = conversation.messageInTransaction(db, messageId);
		if (
			!found ||
			found.message.conversationId !== conversationId ||
			found.message.role !== "user"
		)
			return { ok: false, reason: "invalid_source" };
		if (isBlocked(db, messageId))
			return { ok: false, reason: "blocked_source" };
		const text = found.message.text;
		let span = quote ? locateQuoteSpan(text, quote) : null;
		// Too short to evidence anything.
		if (span && foldedLength(text.slice(span.start, span.end)) < 2) span = null;
		const quoteMatched = span !== null;
		const window = evidenceWindow(text, span, hint, MAX_QUOTE_BYTES);
		if (window.end <= window.start)
			return { ok: false, reason: "invalid_source" };
		const startByte = byteLength(text.slice(0, window.start));
		const source = hostMessageSource(found);
		return {
			ok: true,
			quoteMatched,
			runId: found.message.runId,
			source,
			evidence: {
				source: refOf(source, {
					startByte,
					endByte: startByte + byteLength(text.slice(window.start, window.end)),
				}),
				quote: text.slice(window.start, window.end),
			},
		};
	}

	/** The evidence a source item stands on that can still be used: the message exists, is not blocked or tombstoned, and the range reads. */
	function usableEvidence(
		db: Database,
		source: StateItem,
	): Array<{ evidence: Evidence; host: HostSourceState }> {
		const out: Array<{ evidence: Evidence; host: HostSourceState }> = [];
		for (const ref of source.evidence) {
			if (ref.namespace !== "conversation" || !ref.range) continue;
			if (isBlocked(db, ref.id) || sourceTombstoned(db, ref.id)) continue;
			const found = conversation.messageInTransaction(db, ref.id);
			if (!found) continue;
			const slice = sliceUtf8Range(found.message.text, ref.range);
			if (slice.status !== "ok" || slice.text === "") continue;
			if (byteLength(slice.text) > MAX_QUOTE_BYTES) continue;
			const host = hostMessageSource(found);
			out.push({
				host,
				evidence: { source: refOf(host, ref.range), quote: slice.text },
			});
		}
		return out;
	}

	return { evidenceFrom, usableEvidence };
}
export type EvidenceBuilder = ReturnType<typeof createEvidence>;
