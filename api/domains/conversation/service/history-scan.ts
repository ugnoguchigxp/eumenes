import type { Database } from "bun:sqlite";
import type { HistoryOwner, HistoryView } from "../contracts/history";
import { historySearchInput } from "../contracts/history";
import { historyChunk, type HistoryRow } from "../repository/history";
const byteSize = (v: unknown) => Buffer.byteLength(JSON.stringify(v));

const normalizeSearch = (text: string) => text.normalize("NFKC").toLowerCase();

function queryTokens(query: string): string[] {
	const normalized = normalizeSearch(query).trim();
	return normalized ? normalized.split(/[\s\u3000]+/).filter(Boolean) : [];
}

function matchOffset(rawText: string, normText: string, token: string): number {
	const exact = rawText.indexOf(token);
	if (exact >= 0) return exact;
	const idx = normText.indexOf(token);
	return idx >= 0 ? Math.min(idx, rawText.length) : 0;
}

export type HistoryPosition = {
	session: string;
	messageId: string | null;
	offset: number;
	purpose: "search" | "read";
	messageRef?: string;
};
export function scanHistory(
	db: Database,
	owner: HistoryOwner,
	c: ReturnType<typeof historySearchInput.parse>,
	sessionId: string,
	rows: HistoryRow[],
	last: string | null,
	offset: number,
	view: (
		db: Database,
		session: string,
		row: HistoryRow,
		start: number,
		count: number,
	) => HistoryView,
) {
	const candidates: HistoryView[] = [];
	const partialHits: Array<{ hits: number; view: HistoryView }> = [];
	const tokens = queryTokens(c.query);
	const overlapLen = tokens.length
		? Math.max(...tokens.map((t) => Array.from(t).length))
		: 0;
	let scannedBytes = 0,
		scannedMessages = 0,
		complete = true;
	let next: HistoryPosition | null = null;
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i]!;
		if (scannedMessages >= 500 || scannedBytes >= 1048576) {
			next = {
				session: sessionId,
				messageId: last,
				offset,
				purpose: "search",
			};
			complete = false;
			break;
		}
		scannedMessages++;
		const matches =
			(!c.speaker || row.role === c.speaker) &&
			(!c.from || Date.parse(row.created_at) >= Date.parse(c.from)) &&
			(!c.until || Date.parse(row.created_at) < Date.parse(c.until));
		let pos = i === 0 ? offset : 0;
		if (matches)
			do {
				// SQLite positions are Unicode code points. Overlap preserves matches across chunks.
				const count = Math.min(64000, Math.floor((1048576 - scannedBytes) / 4));
				if (count <= overlapLen) {
					next = {
						session: sessionId,
						messageId: row.id,
						offset: pos,
						purpose: "search",
					};
					complete = false;
					break;
				}
				const text = historyChunk(db, owner.conversationId, row.id, pos, count);
				scannedBytes += Buffer.byteLength(text);
				const normText = tokens.length ? normalizeSearch(text) : "";
				const hitTokens = tokens.length
					? tokens.filter((t) => normText.includes(t))
					: [];
				const allMatched =
					tokens.length === 0 || hitTokens.length === tokens.length;
				if (allMatched) {
					const found = tokens.length
						? matchOffset(text, normText, tokens[0]!)
						: 0;
					const start =
						pos + Math.max(0, Array.from(text.slice(0, found)).length - 80);
					const candidate = view(db, sessionId, row, start, 300);
					if (byteSize({ candidates: [...candidates, candidate] }) > 12000) {
						next = {
							session: sessionId,
							messageId: row.id,
							offset: pos,
							purpose: "search",
						};
						complete = false;
						break;
					}
					candidates.push(candidate);
					pos = row.size; // One candidate per message; read explores its remaining text.
				} else {
					// Record partial multi-token hits as a fallback when no AND match is found.
					if (
						tokens.length > 1 &&
						hitTokens.length > 0 &&
						partialHits.length < 20 &&
						!partialHits.some((p) => p.view.messageId === row.id)
					) {
						const found = matchOffset(text, normText, hitTokens[0]!);
						const start =
							pos + Math.max(0, Array.from(text.slice(0, found)).length - 80);
						partialHits.push({
							hits: hitTokens.length,
							view: view(db, sessionId, row, start, 300),
						});
					}
					const length = Array.from(text).length;
					pos += length < count ? length : Math.max(1, length - overlapLen + 1);
				}
				if (pos < row.size && scannedBytes >= 1048576 - 800) {
					next = {
						session: sessionId,
						messageId: row.id,
						offset: pos,
						purpose: "search",
					};
					complete = false;
					break;
				}
			} while (pos < row.size);
		if (next) break;
		last = row.id;
		offset = 0;
		if (candidates.length >= c.limit && i < rows.length - 1) {
			next = {
				session: sessionId,
				messageId: last,
				offset: 0,
				purpose: "search",
			};
			complete = false;
			break;
		}
	}
	if (!candidates.length && partialHits.length) {
		partialHits.sort((a, b) => b.hits - a.hits);
		for (const item of partialHits.slice(0, Math.min(5, c.limit))) {
			if (byteSize({ candidates: [...candidates, item.view] }) > 12000) break;
			candidates.push(item.view);
		}
	}
	return { candidates, scannedBytes, scannedMessages, complete, next };
}
