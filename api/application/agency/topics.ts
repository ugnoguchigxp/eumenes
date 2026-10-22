import type { HostTopic } from "eumenes-agency";
import type { MemoryItemDto } from "../../domains/memory";

/** Topic seeds per opportunity (the agency prompt stays short). */
export const MAX_TOPICS = 8;
export const MAX_TOPIC_CHARS = 80;
/** State kinds that make talk material, most useful first; constraints are rules, not topics. */
const TOPIC_KINDS = ["preference", "habit", "personal_fact"] as const;

type TopicSource = Pick<
	MemoryItemDto,
	| "id"
	| "kind"
	| "text"
	| "polarity"
	| "status"
	| "validFromMs"
	| "validUntilMs"
>;

const oneLine = (text: string) => {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > MAX_TOPIC_CHARS
		? `${flat.slice(0, MAX_TOPIC_CHARS - 1)}…`
		: flat;
};

/**
 * The user's active State items (what Eumenes memory knows they like, do or are) as agency topic seeds.
 * Affirmed, active and currently valid items only; the id is the memory item id (stable), the order is kind
 * priority, then newest `validFrom`, then id, so the same memory yields the same list.
 */
export function selectMemoryTopics(
	items: readonly TopicSource[],
	nowMs: number,
): HostTopic[] {
	const rank = (kind: string) => {
		const index = (TOPIC_KINDS as readonly string[]).indexOf(kind);
		return index < 0 ? Number.POSITIVE_INFINITY : index;
	};
	const usable = items
		.filter(
			(item) =>
				rank(item.kind) !== Number.POSITIVE_INFINITY &&
				item.polarity === "affirmed" &&
				item.status === "active" &&
				(item.validFromMs === null || item.validFromMs <= nowMs) &&
				(item.validUntilMs === null || item.validUntilMs > nowMs) &&
				oneLine(item.text) !== "",
		)
		.sort(
			(a, b) =>
				rank(a.kind) - rank(b.kind) ||
				(b.validFromMs ?? 0) - (a.validFromMs ?? 0) ||
				a.id.localeCompare(b.id),
		);
	const seen = new Set<string>();
	const topics: HostTopic[] = [];
	for (const item of usable) {
		const text = oneLine(item.text);
		if (seen.has(text)) continue;
		seen.add(text);
		topics.push({ id: item.id, text });
		if (topics.length >= MAX_TOPICS) break;
	}
	return topics;
}
