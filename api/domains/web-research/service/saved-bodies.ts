import {
	createBodyStorage,
	savedFingerprint,
	type SavedPositionInput,
	type BodyGrant,
} from "./body-storage";
import { createHash } from "node:crypto";
export type BodyOwner = {
	rootRunId: string;
	taskId: string;
	cancelEpoch: number;
};
export type AcquiredBody = {
	url: string;
	title: string;
	text: string;
	fetchedAt: string;
	acquisitionTruncated: boolean;
};
export type SavedView = {
	kind: "web_source";
	sourceId: string;
	sourceRef: string;
	sourceRevision: string;
	viewId: string;
	viewDigest: string;
	url: string;
	title: string;
	basis: "page";
	fetchedAt: string;
	body: string;
	truncated: boolean;
	acquisitionTruncated: boolean;
	previewTruncated: boolean;
	start: number;
	end: number;
	nextCursor: string | null;
	previousCursor: string | null;
};
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const key = (o: BodyOwner) => JSON.stringify(o);
/** Search-only normalization with a code-point position map; quotes always use the original text. */
export function normalizedPositions(text: string) {
	const parts: string[] = [],
		positions: number[] = [],
		ends: number[] = [];
	let offset = 0;
	for (const segment of new Intl.Segmenter("und", {
		granularity: "grapheme",
	}).segment(text)) {
		const count = Array.from(segment.segment).length;
		const value = segment.segment.normalize("NFKC").toLowerCase();
		parts.push(value);
		for (let i = 0; i < value.length; i++) {
			positions.push(offset);
			ends.push(offset + count);
		}
		offset += count;
	}
	return { text: parts.join(""), positions, ends };
}
export function createSavedBodies(
	now = Date.now,
	limits = { perTask: 1048576, total: 16777216, count: 64 },
) {
	const { bodies, deliveries, stage, deliveryText, pruneBodies } =
		createBodyStorage(now, limits);
	const grants = new Map<string, BodyGrant>();
	const cursors = new Map<
		string,
		{
			sourceRef: string;
			position: number;
			query?: string;
			purpose: "find" | "read";
		}
	>();
	const views = new Map<
		string,
		{ sourceRef: string; digest: string; start: number; end: number }
	>();
	function prune() {
		for (const [ref, g] of grants) if (g.expires <= now()) grants.delete(ref);
		pruneBodies(new Set([...grants.values()].map((g) => g.body)));
		for (const map of [cursors, views])
			for (const [id, v] of map) if (!grants.has(v.sourceRef)) map.delete(id);
		for (const [id, list] of deliveries)
			if (!list.some((x) => bodies.has(x))) deliveries.delete(id);
	}
	function lookup(owner: BodyOwner, sourceRef: string, reading = true) {
		prune();
		const g = grants.get(sourceRef);
		if (!g) throw new Error("source_expired");
		if (key(g.owner) !== key(owner)) throw new Error("source_ref_invalid");
		if (reading && g.readUntil <= now()) throw new Error("source_expired");
		const b = bodies.get(g.body);
		if (!b) throw new Error("body_unavailable");
		return { g, b };
	}
	function cursor(
		sourceRef: string,
		position: number,
		purpose: "read" | "find",
		query?: string,
	) {
		if (cursors.size >= 4096) throw new Error("reference_capacity");
		const ref = crypto.randomUUID();
		cursors.set(ref, { sourceRef, position, purpose, query });
		return ref;
	}
	function read(
		owner: BodyOwner,
		input: {
			sourceRef: string;
			cursor?: string;
			start?: "head";
			characters?: number;
		},
	) {
		const { g, b } = lookup(owner, input.sourceRef);
		let start = 0;
		if (input.cursor) {
			const p = cursors.get(input.cursor);
			if (!p || p.sourceRef !== input.sourceRef || p.purpose !== "read")
				throw new Error("source_cursor_invalid");
			start = p.position;
		}
		const requested = input.characters ?? 2400;
		if (!Number.isInteger(requested) || requested < 1 || requested > 2400)
			throw new Error("invalid_read_size");
		let body = "",
			end = start;
		while (end < b.points.length && end - start < requested) {
			const candidate = body + b.points[end];
			if (Buffer.byteLength(JSON.stringify(candidate)) > 6800) break;
			body = candidate;
			end++;
		}
		if (views.size >= 4096) throw new Error("reference_capacity");
		const viewId = crypto.randomUUID(),
			viewDigest = sha(body);
		views.set(viewId, {
			sourceRef: input.sourceRef,
			digest: viewDigest,
			start,
			end,
		});
		const value: SavedView = {
			kind: "web_source",
			sourceId: g.sourceId,
			sourceRef: input.sourceRef,
			sourceRevision: g.sourceRevision,
			viewId,
			viewDigest,
			url: b.url,
			title: b.title,
			basis: "page",
			fetchedAt: b.fetchedAt,
			body,
			truncated: b.acquisitionTruncated || start > 0 || end < b.points.length,
			acquisitionTruncated: b.acquisitionTruncated,
			previewTruncated: start > 0 || end < b.points.length,
			start,
			end,
			nextCursor:
				end < b.points.length ? cursor(input.sourceRef, end, "read") : null,
			previousCursor:
				start > 0
					? cursor(input.sourceRef, Math.max(0, start - requested), "read")
					: null,
		};
		return value;
	}
	function issue(
		operationId: string,
		owner: BodyOwner,
		rootDeadline: number,
		childDeadline: number,
	): SavedView[] {
		prune();
		const result: SavedView[] = [];
		for (const id of deliveries.get(operationId) ?? []) {
			const b = bodies.get(id);
			if (!b) continue;
			let sourceRef = [...grants].find(
				([, g]) =>
					g.body === id &&
					g.operationId === operationId &&
					key(g.owner) === key(owner),
			)?.[0];
			if (!sourceRef) {
				const used = new Set(
					[...grants.values()]
						.filter((g) => g.owner.taskId === owner.taskId)
						.map((g) => g.body),
				);
				if (
					[...used].reduce((a, k) => a + (bodies.get(k)?.bytes ?? 0), 0) +
						(used.has(id) ? 0 : b.bytes) >
					limits.perTask
				)
					continue;
				sourceRef = crypto.randomUUID();
				grants.set(sourceRef, {
					owner,
					body: id,
					operationId,
					sourceId: crypto.randomUUID(),
					sourceRevision: crypto.randomUUID() + ":" + b.digest,
					expires: Math.min(b.expires, rootDeadline),
					readUntil: childDeadline,
				});
			}
			result.push(read(owner, { sourceRef, characters: 1200 }));
			if (b.points.length > 2400)
				result.push(
					read(owner, {
						sourceRef,
						cursor: cursor(sourceRef, b.points.length - 1200, "read"),
						characters: 1200,
					}),
				);
		}
		return result;
	}
	function find(
		owner: BodyOwner,
		input: { sourceRef: string; query: string; cursor?: string },
	) {
		const { b } = lookup(owner, input.sourceRef);
		const query = input.query.normalize("NFKC").toLowerCase();
		if (!query.trim() || query.length > 200)
			throw new Error("invalid_find_query");
		const normalized = normalizedPositions(b.text);
		let at = 0;
		if (input.cursor) {
			const p = cursors.get(input.cursor);
			if (
				!p ||
				p.sourceRef !== input.sourceRef ||
				p.purpose !== "find" ||
				p.query !== query
			)
				throw new Error("source_cursor_invalid");
			at = p.position;
		}
		const matches: Array<{
			text: string;
			start: number;
			end: number;
			cursor: string;
		}> = [];
		while (matches.length < 5) {
			const found = normalized.text.indexOf(query, at);
			if (found < 0) {
				at = normalized.text.length;
				break;
			}
			const start = normalized.positions[found]!,
				end = normalized.ends[found + query.length - 1]!;
			const match = {
				text: b.points
					.slice(
						Math.max(0, start - 40),
						Math.min(b.points.length, end + 40, start + 240),
					)
					.join(""),
				start,
				end,
				cursor: cursor(input.sourceRef, Math.max(0, start - 80), "read"),
			};
			if (
				Buffer.byteLength(JSON.stringify({ matches: [...matches, match] })) >
				7600
			) {
				at = found;
				break;
			}
			matches.push(match);
			at = found + query.length;
		}
		const hasMore = normalized.text.indexOf(query, at) >= 0;
		return {
			sourceRef: input.sourceRef,
			matches,
			hasMore,
			cursor: hasMore ? cursor(input.sourceRef, at, "find", query) : null,
			acquisitionTruncated: b.acquisitionTruncated,
		};
	}
	function validate(
		owner: BodyOwner,
		evidence: Array<{
			sourceRef?: string;
			sourceRevision?: string;
			viewId?: string;
			viewDigest?: string;
		}>,
	) {
		try {
			return evidence.every((e) => {
				if (!e.sourceRef || !e.viewId) return false;
				const { g, b } = lookup(owner, e.sourceRef, false),
					v = views.get(e.viewId);
				return (
					v?.sourceRef === e.sourceRef &&
					g.sourceRevision === e.sourceRevision &&
					v.digest === e.viewDigest &&
					sha(b.points.slice(v.start, v.end).join("")) === v.digest
				);
			});
		} catch {
			return false;
		}
	}
	return {
		fingerprint: (owner: BodyOwner, input: SavedPositionInput, kind: string) =>
			savedFingerprint(owner, input, kind, lookup, cursors),
		stage,
		deliveryText,
		issue,
		read,
		find,
		validate,
		forgetDelivery(operationId: string) {
			for (const id of deliveries.get(operationId) ?? [])
				bodies.get(id)?.deliveries.delete(operationId);
			deliveries.delete(operationId);
			prune();
		},
		releaseTask(taskId: string) {
			for (const g of grants.values())
				if (g.owner.taskId === taskId) g.readUntil = 0;
		},
		releaseRoot(rootRunId: string) {
			for (const [ref, g] of grants)
				if (g.owner.rootRunId === rootRunId) grants.delete(ref);
			prune();
		},
		close() {
			bodies.clear();
			deliveries.clear();
			grants.clear();
			cursors.clear();
			views.clear();
		},
	};
}
