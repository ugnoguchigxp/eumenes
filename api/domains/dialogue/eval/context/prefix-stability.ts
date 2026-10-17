/**
 * Machine metric (spec 5.4 / 7.2): how much of the previous call's prompt the next call shares as a prefix.
 * Prompt caches reuse a byte-identical prefix, so the unit is bytes of the canonical serialization.
 */
import type { ChatMessage } from "../../service/context";

/** JSON with object keys sorted at every level, so equal content serializes identically. */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object")
		return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** One message per line, so a shared prefix of lines is a shared prefix of messages. */
export function serializeCall(messages: readonly ChatMessage[]): Buffer {
	return Buffer.from(messages.map((m) => canonicalJson(m)).join("\n"), "utf8");
}

export function commonPrefixBytes(a: Uint8Array, b: Uint8Array): number {
	const limit = Math.min(a.length, b.length);
	let i = 0;
	while (i < limit && a[i] === b[i]) i++;
	return i;
}

export type PrefixPair = {
	/** Zero-based index of the earlier call. */
	from: number;
	sharedBytes: number;
	previousBytes: number;
	nextBytes: number;
	/** sharedBytes / previousBytes: the part of the earlier prompt a cache could reuse. 1 when the earlier prompt is empty. */
	ratio: number;
};
export type PrefixStability = {
	pairs: PrefixPair[];
	/** Median of the pair ratios, or null with fewer than two calls. */
	medianRatio: number | null;
};

export function median(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2
		? sorted[mid]!
		: (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Shared-prefix bytes between consecutive calls of one conversation (each call is its full message list). */
export function prefixStability(
	calls: ReadonlyArray<readonly ChatMessage[]>,
): PrefixStability {
	const serialized = calls.map(serializeCall);
	const pairs: PrefixPair[] = [];
	for (let i = 0; i + 1 < serialized.length; i++) {
		const previous = serialized[i]!;
		const next = serialized[i + 1]!;
		const sharedBytes = commonPrefixBytes(previous, next);
		pairs.push({
			from: i,
			sharedBytes,
			previousBytes: previous.length,
			nextBytes: next.length,
			ratio: previous.length === 0 ? 1 : sharedBytes / previous.length,
		});
	}
	return { pairs, medianRatio: median(pairs.map((p) => p.ratio)) };
}
