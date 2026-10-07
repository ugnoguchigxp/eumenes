import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { ConversationService } from "../../conversation";
import {
	ACTIVE_BOOKMARK_MAX,
	type Bookmark,
	type BookmarkHistory,
	type BookmarkList,
	type BookmarkSource,
	ContinuityError,
	type ContinuitySnapshot,
	type CreateBookmarkRequest,
	type DeactivateBookmarkRequest,
	HISTORY_DEFAULT_LIMIT,
	HISTORY_MAX_LIMIT,
	type ReviseBookmarkRequest,
	type SourceStatus,
} from "../contracts";
import {
	countActive,
	eventByRequest,
	insertEvent,
	latestEvent,
	listBookmarks,
	listHistory,
	type StoredEvent,
	stateRevision,
	toBookmark,
	toPublicEvent,
} from "../repository";

type SourceMessage = NonNullable<BookmarkSource["message"]>;

const sha256 = (value: string) =>
	createHash("sha256").update(value, "utf8").digest("hex");

/** Canonical (fixed key order) digest of one write operation's normalized input. */
function requestDigest(
	operation: string,
	bookmarkId: string | null,
	input: Record<string, string | number>,
): string {
	return sha256(
		JSON.stringify([
			operation,
			bookmarkId,
			Object.entries(input).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
		]),
	);
}

function sourceStatus(
	sourceDigest: string,
	message: SourceMessage | undefined,
): SourceStatus {
	if (!message || message.role !== "user") return "missing";
	return sha256(message.text) === sourceDigest ? "ok" : "changed";
}

export function createContinuityService(
	store: SqliteStore,
	conversation: ConversationService,
) {
	/** Run reads inside one read transaction so all statements share a snapshot. */
	const readSnapshot = <T>(operation: (db: Database) => T): T =>
		store.read((db) => db.transaction(() => operation(db))());

	const originFor = (
		text: string,
		source: SourceMessage | undefined,
		digest: string,
	): Bookmark["origin"] =>
		source && sha256(source.text) === digest && source.text.trim() === text
			? "user_confirmed"
			: "user_edited";

	function replay(
		db: Database,
		conversationId: string,
		requestId: string,
		digest: string,
	): Bookmark | null {
		const existing = eventByRequest(db, conversationId, requestId);
		if (!existing) return null;
		if (existing.requestDigest !== digest)
			throw new ContinuityError("request_conflict");
		return toBookmark(existing);
	}

	function currentOrThrow(
		db: Database,
		conversationId: string,
		bookmarkId: string,
	): StoredEvent {
		const latest = latestEvent(db, conversationId, bookmarkId);
		if (!latest) throw new ContinuityError("not_found", "bookmark");
		return latest;
	}

	function append(
		db: Database,
		base: StoredEvent,
		change: {
			operation: "revise" | "deactivate";
			kind: Bookmark["kind"];
			text: string;
			status: Bookmark["status"];
			origin: Bookmark["origin"];
			requestId: string;
			requestDigest: string;
		},
	): Bookmark {
		const event = {
			id: randomUUID(),
			bookmarkId: base.bookmarkId,
			conversationId: base.conversationId,
			sourceMessageId: base.sourceMessageId,
			sourceDigest: base.sourceDigest,
			revision: base.revision + 1,
			createdAt: new Date().toISOString(),
			...change,
		};
		insertEvent(db, event);
		const stored = latestEvent(db, base.conversationId, base.bookmarkId);
		if (!stored) throw new Error("continuity_event_missing");
		return toBookmark(stored);
	}

	return {
		list(
			conversationId: string,
			options: { includeInactive?: boolean } = {},
		): BookmarkList {
			return readSnapshot((db) => ({
				conversationId,
				stateRevision: stateRevision(db, conversationId),
				bookmarks: listBookmarks(
					db,
					conversationId,
					options.includeInactive === true,
				),
			}));
		},

		create(
			conversationId: string,
			request: CreateBookmarkRequest,
		): Promise<Bookmark> {
			const text = request.text.trim();
			const digest = requestDigest("create", null, {
				sourceMessageId: request.sourceMessageId,
				kind: request.kind,
				text,
			});
			return store.write((db) => {
				const replayed = replay(db, conversationId, request.requestId, digest);
				if (replayed) return replayed;
				const source = conversation
					.messagesInTransaction(db, conversationId)
					.find((m) => m.id === request.sourceMessageId);
				if (!source) throw new ContinuityError("not_found", "source");
				if (source.role !== "user")
					throw new ContinuityError("invalid_request", "source_not_user");
				if (countActive(db, conversationId) >= ACTIVE_BOOKMARK_MAX)
					throw new ContinuityError("bookmark_limit_exceeded");
				const sourceDigest = sha256(source.text);
				const now = new Date().toISOString();
				const bookmarkId = randomUUID();
				insertEvent(db, {
					id: randomUUID(),
					bookmarkId,
					conversationId,
					operation: "create",
					kind: request.kind,
					text,
					status: "active",
					revision: 1,
					sourceMessageId: source.id,
					sourceDigest,
					origin: originFor(text, source, sourceDigest),
					requestId: request.requestId,
					requestDigest: digest,
					createdAt: now,
				});
				const stored = latestEvent(db, conversationId, bookmarkId);
				if (!stored) throw new Error("continuity_event_missing");
				return toBookmark(stored);
			});
		},

		revise(
			conversationId: string,
			bookmarkId: string,
			request: ReviseBookmarkRequest,
		): Promise<Bookmark> {
			const text = request.text.trim();
			const digest = requestDigest("revise", bookmarkId, {
				expectedRevision: request.expectedRevision,
				kind: request.kind,
				text,
			});
			return store.write((db) => {
				const replayed = replay(db, conversationId, request.requestId, digest);
				if (replayed) return replayed;
				const latest = currentOrThrow(db, conversationId, bookmarkId);
				if (latest.status !== "active")
					throw new ContinuityError("bookmark_inactive");
				if (latest.revision !== request.expectedRevision)
					throw new ContinuityError("revision_conflict");
				const source = conversation
					.messagesInTransaction(db, conversationId)
					.find((m) => m.id === latest.sourceMessageId);
				return append(db, latest, {
					operation: "revise",
					kind: request.kind,
					text,
					status: "active",
					origin: originFor(text, source, latest.sourceDigest),
					requestId: request.requestId,
					requestDigest: digest,
				});
			});
		},

		deactivate(
			conversationId: string,
			bookmarkId: string,
			request: DeactivateBookmarkRequest,
		): Promise<Bookmark> {
			const digest = requestDigest("deactivate", bookmarkId, {
				expectedRevision: request.expectedRevision,
			});
			return store.write((db) => {
				const replayed = replay(db, conversationId, request.requestId, digest);
				if (replayed) return replayed;
				const latest = currentOrThrow(db, conversationId, bookmarkId);
				if (latest.status !== "active")
					throw new ContinuityError("bookmark_inactive");
				if (latest.revision !== request.expectedRevision)
					throw new ContinuityError("revision_conflict");
				return append(db, latest, {
					operation: "deactivate",
					kind: latest.kind,
					text: latest.text,
					status: "inactive",
					origin: latest.origin,
					requestId: request.requestId,
					requestDigest: digest,
				});
			});
		},

		history(
			conversationId: string,
			bookmarkId: string,
			options: { after?: number; limit?: number } = {},
		): BookmarkHistory {
			const limit = Math.min(
				Math.max(Math.trunc(options.limit ?? HISTORY_DEFAULT_LIMIT), 1),
				HISTORY_MAX_LIMIT,
			);
			const after = Math.max(Math.trunc(options.after ?? 0), 0);
			return readSnapshot((db) => {
				currentOrThrow(db, conversationId, bookmarkId);
				const rows = listHistory(
					db,
					conversationId,
					bookmarkId,
					after,
					limit + 1,
				);
				const page = rows.slice(0, limit);
				return {
					bookmarkId,
					events: page.map(toPublicEvent),
					nextCursor:
						rows.length > limit
							? (page[page.length - 1]?.sequence ?? null)
							: null,
				};
			});
		},

		source(conversationId: string, bookmarkId: string): BookmarkSource {
			return readSnapshot((db) => {
				const latest = currentOrThrow(db, conversationId, bookmarkId);
				const message = conversation
					.messagesInTransaction(db, conversationId)
					.find((m) => m.id === latest.sourceMessageId);
				return {
					bookmarkId,
					sourceMessageId: latest.sourceMessageId,
					sourceDigest: latest.sourceDigest,
					status: sourceStatus(latest.sourceDigest, message),
					message: message
						? {
								id: message.id,
								role: message.role,
								text: message.text,
								createdAt: message.createdAt,
							}
						: null,
				};
			});
		},

		getSnapshot(conversationId: string): ContinuitySnapshot {
			return readSnapshot((db) => {
				const messages = new Map(
					conversation
						.messagesInTransaction(db, conversationId)
						.map((m) => [m.id, m]),
				);
				return {
					conversationId,
					stateRevision: stateRevision(db, conversationId),
					items: listBookmarks(db, conversationId, false).map((bookmark) => ({
						bookmark,
						sourceStatus: sourceStatus(
							bookmark.sourceDigest,
							messages.get(bookmark.sourceMessageId),
						),
					})),
				};
			});
		},
	};
}
export type ContinuityService = ReturnType<typeof createContinuityService>;
