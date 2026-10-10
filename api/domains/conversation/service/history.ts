import { historyFingerprint } from "./history-fingerprint";
import { scanHistory, type HistoryPosition } from "./history-scan";
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
	historySearchInput,
	historyReadInput,
	type HistoryOwner,
	type HistoryView,
	type HistoryScope,
} from "../contracts/history";
import { revision, sourceState, type OutboxOptions } from "../repository";
import {
	historyBound,
	historyBatch,
	historyChunk,
	historyIdentity,
	historyNeighbors,
	type HistoryRow,
} from "../repository/history";
const sha = (v: unknown) =>
	createHash("sha256")
		.update(typeof v === "string" ? v : JSON.stringify(v))
		.digest("hex");
const byteSize = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
const PER_OWNER_SESSIONS = 8;
type Conditions = ReturnType<typeof historySearchInput.parse>;
type Session = {
	owner: HistoryOwner;
	revision: number;
	bound: string | null;
	conditions: Conditions;
	expires: number;
	scope: HistoryScope;
};
type Position = HistoryPosition;
/** Only identities and positions are retained. All excerpts come from the current conversation source. */
export function createHistory(now: () => number, outbox: OutboxOptions) {
	const sessions = new Map<string, Session>();
	const cursors = new Map<string, Position>();
	const messages = new Map<
		string,
		{ session: string; messageId: string; offset: number }
	>();
	const views = new Map<
		string,
		{
			session: string;
			messageId: string;
			revision: string;
			digest: string;
			viewDigest: string;
			start: number;
			end: number;
		}
	>();
	function prune() {
		for (const [id, s] of sessions) if (s.expires <= now()) sessions.delete(id);
		for (const map of [cursors, messages, views])
			for (const [id, p] of map) if (!sessions.has(p.session)) map.delete(id);
	}
	function resolve(db: Database, owner: HistoryOwner, id: string) {
		prune();
		const s = sessions.get(id);
		if (!s) throw new Error("source_expired");
		if (
			s.owner.key !== owner.key ||
			s.owner.conversationId !== owner.conversationId
		)
			throw new Error("history_ref_invalid");
		if (owner.deadline <= now()) throw new Error("source_expired");
		if (revision(db, owner.conversationId) !== s.revision)
			throw new Error("history_cursor_stale");
		return s;
	}
	function cursor(position: Position) {
		if (cursors.size >= 4096) throw new Error("history_capacity");
		const id = crypto.randomUUID();
		cursors.set(id, position);
		return id;
	}
	function view(
		db: Database,
		sessionId: string,
		row: HistoryRow,
		start: number,
		count: number,
	): HistoryView {
		const s = sessions.get(sessionId)!;
		const text = historyChunk(db, s.owner.conversationId, row.id, start, count);
		const identity = historyIdentity(db, row.id);
		const end = start + Array.from(text).length;
		if (views.size >= 4096 || messages.size >= 4096)
			throw new Error("history_capacity");
		const messageRef = crypto.randomUUID(),
			viewId = crypto.randomUUID();
		messages.set(messageRef, {
			session: sessionId,
			messageId: row.id,
			offset: start,
		});
		const metadata = {
			session: sessionId,
			messageId: row.id,
			...identity,
			viewDigest: sha(text),
			start,
			end,
		};
		views.set(viewId, metadata);
		return {
			kind: "conversation_source",
			messageRef,
			messageId: row.id,
			conversationId: s.owner.conversationId,
			speaker: row.role,
			createdAt: row.created_at,
			...identity,
			viewId,
			viewDigest: metadata.viewDigest,
			start,
			end,
			text,
			truncated: start > 0 || end < row.size,
			nextCursor:
				end < row.size
					? cursor({
							session: sessionId,
							messageId: row.id,
							offset: end,
							purpose: "read",
							messageRef,
						})
					: null,
		};
	}
	function search(db: Database, owner: HistoryOwner, raw: unknown) {
		const c = historySearchInput.parse(raw);
		let sessionId: string;
		let last: string | null = null,
			offset = 0;
		if (c.cursor) {
			const p = cursors.get(c.cursor);
			if (!p || p.purpose !== "search") throw new Error("history_ref_invalid");
			sessionId = p.session;
			last = p.messageId;
			offset = p.offset;
			const s = resolve(db, owner, sessionId);
			if (
				sha({ ...c, cursor: undefined }) !==
				sha({ ...s.conditions, cursor: undefined })
			)
				throw new Error("history_cursor_conditions");
		} else {
			prune();
			const own = [...sessions.entries()].filter(
				([, session]) => session.owner.key === owner.key,
			);
			if (own.length >= PER_OWNER_SESSIONS) {
				// The owner's oldest search is dropped; its cursor then reports history_ref_invalid.
				const [oldestId] = own.reduce((a, b) =>
					a[1].expires <= b[1].expires ? a : b,
				);
				sessions.delete(oldestId);
				prune();
			}
			if (sessions.size >= 64) throw new Error("history_capacity");
			sessionId = crypto.randomUUID();
			const expires = Math.min(now() + 900000, owner.deadline);
			if (expires <= now()) throw new Error("source_expired");
			const rev = revision(db, owner.conversationId);
			const scope: HistoryScope = {
				conversationId: owner.conversationId,
				conversationRevision: rev,
				scopeRef: sessionId,
				scannedMessages: 0,
				scannedBytes: 0,
				scanComplete: false,
				expiresAt: new Date(expires).toISOString(),
			};
			sessions.set(sessionId, {
				owner,
				revision: rev,
				bound: historyBound(db, owner.conversationId, owner.excludeMessageId),
				conditions: c,
				expires,
				scope,
			});
		}
		const s = resolve(db, owner, sessionId);
		const rows = historyBatch(
			db,
			owner.conversationId,
			s.bound,
			last,
			offset > 0,
			501,
		);
		const { candidates, scannedBytes, scannedMessages, complete, next } =
			scanHistory(db, owner, c, sessionId, rows, last, offset, view);
		const scope = {
			...s.scope,
			scannedBytes,
			scannedMessages,
			scanComplete: complete,
		};
		s.scope = scope;
		return { candidates, cursor: next ? cursor(next) : null, scope };
	}
	function read(db: Database, owner: HistoryOwner, raw: unknown) {
		const input = historyReadInput.parse(raw),
			ref = messages.get(input.messageRef);
		if (!ref) throw new Error("history_ref_invalid");
		const s = resolve(db, owner, ref.session);
		let offset = ref.offset;
		if (input.cursor) {
			const p = cursors.get(input.cursor);
			if (
				!p ||
				p.purpose !== "read" ||
				p.session !== ref.session ||
				p.messageId !== ref.messageId ||
				p.messageRef !== input.messageRef
			)
				throw new Error("history_ref_invalid");
			offset = p.offset;
		}
		const rows = historyNeighbors(
			db,
			owner.conversationId,
			s.bound,
			ref.messageId,
			input.before,
			input.after,
		);
		const result: HistoryView[] = [];
		// Reserve the target first so large preceding messages cannot crowd it out.
		for (const row of [
			...rows.filter((r) => r.id === ref.messageId),
			...rows.filter((r) => r.id !== ref.messageId),
		]) {
			const available =
				8192 - byteSize({ messages: result, scope: s.scope }) - 800;
			if (available < 400) break;
			result.push(
				view(
					db,
					ref.session,
					row,
					row.id === ref.messageId ? offset : 0,
					Math.min(2400, Math.floor(available / 6)),
				),
			);
		}
		result.sort(
			(a, b) =>
				rows.findIndex((r) => r.id === a.messageId) -
				rows.findIndex((r) => r.id === b.messageId),
		);
		return { messages: result, scope: s.scope };
	}
	function validate(
		db: Database,
		owner: HistoryOwner,
		scopeRef: string,
		evidence: Array<{
			viewId: string;
			messageId: string;
			revision: string;
			digest: string;
			viewDigest: string;
		}>,
	) {
		try {
			resolve(db, owner, scopeRef);
			return evidence.every((e) => {
				const v = views.get(e.viewId);
				if (
					!v ||
					v.session !== scopeRef ||
					v.messageId !== e.messageId ||
					v.revision !== e.revision ||
					v.digest !== e.digest ||
					v.viewDigest !== e.viewDigest
				)
					return false;
				const current = sourceState(db, e.messageId, outbox);
				return (
					current.state === "available" &&
					current.message.conversationId === owner.conversationId &&
					current.revision === e.revision &&
					current.digest === e.digest &&
					sha(
						historyChunk(
							db,
							owner.conversationId,
							e.messageId,
							v.start,
							v.end - v.start,
						),
					) === v.viewDigest
				);
			});
		} catch {
			return false;
		}
	}
	return {
		fingerprint: (
			db: Database,
			owner: HistoryOwner,
			raw: unknown,
			kind: string,
		) =>
			historyFingerprint(db, owner, raw, kind, { cursors, messages, resolve }),
		search,
		read,
		validate,
		release(key: string) {
			for (const [id, s] of sessions)
				if (s.owner.key === key) sessions.delete(id);
			prune();
		},
		close() {
			sessions.clear();
			prune();
		},
	};
}
