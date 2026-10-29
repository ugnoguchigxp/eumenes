/**
 * The long-term memory as the conversation reads it (the ContextWindow specification, sections 5.4 and 5.6): one
 * item per current State line or tendency, with no rendered prose. The published order is kept between
 * publications (new items go to the end of their kind), so a republish changes as little of the prompt prefix as
 * the change itself requires.
 */

/** Additions waiting beside the profile before it is republished. */
export const PENDING_LIMIT = 5;

/** Kinds in the order the profile lists them and, when the budget is short, keeps them; tendencies last. */
export const PROFILE_KIND_ORDER = [
	"constraint",
	"preference",
	"personal_fact",
	"habit",
	"tendency",
] as const;

export type ProfileItem = {
	/** The State item id, or `tendency:<id>`. */
	id: string;
	kind: string;
	text: string;
	/** The State says the opposite of `text` ("not …"). */
	negated: boolean;
	/** The user's own statement (State), the agent's inference (State), or an observation (tendency). */
	source: "user_said" | "inferred" | "observed";
	/** The first and last day it holds (Asia/Tokyo, YYYY-MM-DD); absent when unbounded. */
	since?: string;
	until?: string;
	revision: number;
	/** Newer is larger (the package's updated sequence, or the tendency's update time in ms). Not shown. */
	newness: number;
	/** The exclusive end of its validity in ms, when bounded. Not shown. */
	untilMs?: number;
};

const rank = (kind: string) => {
	const at = (PROFILE_KIND_ORDER as readonly string[]).indexOf(kind);
	return at < 0 ? PROFILE_KIND_ORDER.length : at;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
/** The Asia/Tokyo calendar day of an instant: absolute, never relative to now. */
export function tokyoDay(ms: number): string {
	return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 10);
}
/** The last day a bound that ends at `untilMs` (exclusive) still holds. */
export const lastTokyoDay = (untilMs: number) => tokyoDay(untilMs - 1);
export { DAY_MS };

/**
 * The items in the order the profile shows them: kinds in their fixed order; inside a kind the items of the
 * previous publication in their previous order, then the new ones, oldest first. Same input, same order.
 */
export function publishedOrder(
	items: readonly ProfileItem[],
	previous: readonly string[],
): ProfileItem[] {
	const place = new Map(previous.map((id, index) => [id, index]));
	return [...items].sort((a, b) => {
		const byKind = rank(a.kind) - rank(b.kind);
		if (byKind !== 0) return byKind;
		const pa = place.get(a.id);
		const pb = place.get(b.id);
		if (pa !== undefined && pb !== undefined) return pa - pb;
		if (pa !== undefined) return -1;
		if (pb !== undefined) return 1;
		return a.newness - b.newness || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
	});
}

/** Sources in the order the budget keeps them: what the user said before what was inferred or observed. */
const SOURCE_ORDER: readonly ProfileItem["source"][] = [
	"user_said",
	"inferred",
	"observed",
];

/**
 * The items kept when the profile is over its budget: the user's own statements first, then kinds in their fixed
 * order, newest first inside a kind. This is the order of keeping, never of showing: the kept items are shown in
 * their published order.
 */
export function keepOrder(items: readonly ProfileItem[]): ProfileItem[] {
	return [...items].sort(
		(a, b) =>
			SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source) ||
			rank(a.kind) - rank(b.kind) ||
			b.newness - a.newness ||
			(a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
	);
}

/** What the model reads of one item; the constant labels (reference, remembered) are stated once in the system. */
export function profileItemFields(item: ProfileItem): Record<string, unknown> {
	return {
		id: item.id,
		kind: item.kind,
		text: item.text,
		...(item.negated ? { negated: true } : {}),
		source: item.source,
		...(item.since ? { since: item.since } : {}),
		...(item.until ? { until: item.until } : {}),
	};
}
