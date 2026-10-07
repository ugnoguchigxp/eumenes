import type { ContinuityProjection, ContinuitySnapshot } from "../contracts";

const encoder = new TextEncoder();

function compareCodeUnits(a: string, b: string): number {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}

/**
 * Pure projection of a continuity snapshot into structured data.
 * No IO and no LLM message / system prompt generation. `instructionAuthority`
 * is always "none"; placement and runtime checks are the caller's job.
 */
export function projectContinuity(
	snapshot: ContinuitySnapshot,
	maxBytes: number,
): ContinuityProjection {
	if (!Number.isInteger(maxBytes) || maxBytes < 0) {
		throw new RangeError("maxBytes must be a non-negative integer");
	}
	const { conversationId, stateRevision } = snapshot;

	const activeItems = snapshot.items.filter(
		(item) => item.bookmark.status === "active",
	);
	if (activeItems.some((item) => item.sourceStatus !== "ok")) {
		return {
			status: "blocked",
			conversationId,
			stateRevision,
			instructionAuthority: "none",
			reason: "bookmark source is missing or changed",
		};
	}

	const items = activeItems
		.map(({ bookmark }) => bookmark)
		.sort((a, b) => compareCodeUnits(a.id, b.id))
		.map((bookmark) => ({
			bookmarkId: bookmark.id,
			kind: bookmark.kind,
			text: bookmark.text,
			origin: bookmark.origin,
			source: {
				messageId: bookmark.sourceMessageId,
				digest: bookmark.sourceDigest,
			},
		}));

	const ready: ContinuityProjection = {
		status: "ready",
		conversationId,
		stateRevision,
		instructionAuthority: "none",
		items,
	};
	if (encoder.encode(JSON.stringify(ready)).byteLength > maxBytes) {
		return {
			status: "overflow",
			conversationId,
			stateRevision,
			instructionAuthority: "none",
			reason: "projection exceeds byte budget",
		};
	}
	return ready;
}
