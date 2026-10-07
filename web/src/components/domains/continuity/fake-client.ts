import { vi } from "vitest";
import type {
	Bookmark,
	BookmarkSource,
} from "../../../../../api/domains/continuity/contracts";
import type { ContinuityClient } from "../../../../../client/continuity";

/** Typed in-memory fixture. It is not evidence that the real HTTP API behaves this way. */
export function fakeContinuityClient(
	seed: Bookmark[] = [],
	identity = "http://127.0.0.1:8787",
) {
	let bookmarks = [...seed];
	let counter = 0;
	const now = "2026-01-01T00:00:00.000Z";
	const client = {
		identity,
		list: vi.fn(
			async (
				conversationId: string,
				options: { includeInactive?: boolean } = {},
			) => ({
				conversationId,
				stateRevision: 1,
				bookmarks: bookmarks.filter(
					(b) => options.includeInactive || b.status === "active",
				),
			}),
		),
		create: vi.fn(async (conversationId, request) => {
			counter += 1;
			const bookmark: Bookmark = {
				id: `b${counter}`,
				conversationId,
				kind: request.kind,
				text: request.text,
				status: "active",
				revision: 1,
				origin: "user_confirmed",
				sourceMessageId: request.sourceMessageId,
				sourceDigest: "digest",
				createdAt: now,
				updatedAt: now,
			};
			bookmarks = [...bookmarks, bookmark];
			return bookmark;
		}),
		revise: vi.fn(async (_conversationId, bookmarkId, request) => {
			const current = bookmarks.find((b) => b.id === bookmarkId) as Bookmark;
			const next: Bookmark = {
				...current,
				kind: request.kind,
				text: request.text,
				revision: current.revision + 1,
				origin: "user_edited",
			};
			bookmarks = bookmarks.map((b) => (b.id === bookmarkId ? next : b));
			return next;
		}),
		deactivate: vi.fn(async (_conversationId, bookmarkId, _request) => {
			const current = bookmarks.find((b) => b.id === bookmarkId) as Bookmark;
			const next: Bookmark = {
				...current,
				status: "inactive",
				revision: current.revision + 1,
			};
			bookmarks = bookmarks.map((b) => (b.id === bookmarkId ? next : b));
			return next;
		}),
		history: vi.fn(async (_conversationId, bookmarkId) => ({
			bookmarkId,
			events: bookmarks
				.filter((b) => b.id === bookmarkId)
				.map((b, index) => ({
					sequence: index + 1,
					id: `e${index + 1}`,
					bookmarkId,
					conversationId: b.conversationId,
					operation: "create" as const,
					kind: b.kind,
					text: "最初の文面",
					status: "active" as const,
					revision: 1,
					sourceMessageId: b.sourceMessageId,
					sourceDigest: b.sourceDigest,
					origin: b.origin,
					requestId: "r",
					createdAt: now,
				})),
			nextCursor: null,
		})),
		source: vi.fn(
			async (
				_conversationId: string,
				bookmarkId: string,
			): Promise<BookmarkSource> => ({
				bookmarkId,
				sourceMessageId: "m1",
				sourceDigest: "digest",
				status: "ok",
				message: {
					id: "m1",
					role: "user",
					text: "元の発言です",
					createdAt: now,
				},
			}),
		),
	} satisfies ContinuityClient;
	return client;
}

export const bookmarkFixture = (
	overrides: Partial<Bookmark> = {},
): Bookmark => ({
	id: "b0",
	conversationId: "main",
	kind: "goal",
	text: "既存のしおり",
	status: "active",
	revision: 1,
	origin: "user_confirmed",
	sourceMessageId: "m1",
	sourceDigest: "digest",
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
	...overrides,
});
