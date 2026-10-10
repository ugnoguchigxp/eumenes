import type { Database } from "bun:sqlite";
import type { HistoryOwner, HistoryView } from "../contracts/history";
import { historySearchInput } from "../contracts/history";
import { historyChunk, type HistoryRow } from "../repository/history";
const byteSize = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
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
				if (count <= c.query.length) {
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
				const found = c.query ? text.indexOf(c.query) : 0;
				if (found >= 0) {
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
					const length = Array.from(text).length;
					pos +=
						length < count
							? length
							: Math.max(1, length - Array.from(c.query).length + 1);
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
	return { candidates, scannedBytes, scannedMessages, complete, next };
}
