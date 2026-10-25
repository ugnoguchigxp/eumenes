import { classifyValidity, periodFromStateMs } from "eumenes-memory";
import type { StateItem } from "eumenes-memory/sqlite";
import { sha256Hex } from "../../../infrastructure/digest";
import { estimateJsonTokens } from "../../../infrastructure/context-budget";
import type { ConversationEvent } from "../../continuity";
import { byteLength, type ClippedText, clipMessage } from "./budget";
import type { StepEnv } from "./types";

const pad = (n: number) => String(n).padStart(2, "0");
/** The host's local calendar day of an instant, `YYYY-MM-DD`. */
export function localDay(ms: number): string {
	const date = new Date(ms);
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// ---- the memory the model is shown, with refs ----

export type MemoryRef = {
	/** Memory's own (state, tendency, note) and the shelves a forget request may also name: World's entities and claims, goals. */
	namespace: "state" | "tendency" | "continuity" | "entity" | "claim" | "goal";
	id: string;
	revision: number;
};
export type MemoryDescription = {
	/** "m1", "t1", "n1" -> the item (ids and revisions never reach the model). */
	refs: Record<string, MemoryRef>;
	longTerm: Array<Record<string, unknown>>;
	shortTerm: Array<Record<string, unknown>>;
	/** The items the long-term layer does not carry yet ("recently remembered"). */
	recent: string[];
	coverage: {
		stateTotal: number;
		stateShown: number;
		tendenciesTotal: number;
		tendenciesShown: number;
	};
};

/** The active State items of the profile that count now (past ones are not offered). */
export function activeStateItems(env: StepEnv): StateItem[] {
	const nowMs = env.deps.nowMs();
	return [...env.deps.memory.stateItemsInTransaction(env.db, false)]
		.filter(
			(item) =>
				item.subject === "self" &&
				item.status === "active" &&
				classifyValidity(
					periodFromStateMs(item.validFromMs, item.validUntilMs),
					nowMs,
				) !== "past",
		)
		.sort((a, b) => b.updatedSeq - a.updatedSeq);
}

/**
 * The long-term list (State, then tendencies) and the live notes, each with a short ref. The list is cut where
 * it would outgrow the profile section of the window plan (estimated tokens), newest first.
 */
export function describeMemory(env: StepEnv): MemoryDescription {
	const { db, deps, conversationId } = env;
	const refs: MemoryDescription["refs"] = {};
	const longTerm: MemoryDescription["longTerm"] = [];
	// The items the published profile does not show yet (the window's `newMemories`).
	const recentIds = new Set(
		deps.memory.windows
			.storedInTransaction(db, conversationId)
			?.newMemories.map((item) => item.id) ?? [],
	);
	const recent: string[] = [];
	let tokens = 0;
	const budget = deps.memory.windowPlan().sections.profile;
	const push = (entry: Record<string, unknown>) => {
		const size = estimateJsonTokens(entry);
		if (tokens + size > budget) return false;
		tokens += size;
		longTerm.push(entry);
		return true;
	};
	let m = 0;
	const stateItems = activeStateItems(env);
	for (const item of stateItems) {
		const ref = `lm${m + 1}`;
		const entry: Record<string, unknown> = {
			ref,
			kind: item.kind,
			key: item.semanticKey,
			origin: item.origin,
			text: item.value.text,
			...(item.value.polarity === "negated" ? { polarity: "negated" } : {}),
			...(item.validFromMs === null
				? {}
				: { validFrom: localDay(item.validFromMs) }),
			...(item.validUntilMs === null
				? {}
				: { validUntil: localDay(item.validUntilMs - 1) }),
			...(recentIds.has(item.itemId) ? { recent: true } : {}),
		};
		if (!push(entry)) break;
		m++;
		refs[ref] = {
			namespace: "state",
			id: item.itemId,
			revision: item.revision,
		};
		if (recentIds.has(item.itemId)) recent.push(ref);
	}
	let t = 0;
	const tendencies = deps.memory.tendencies();
	for (const row of tendencies) {
		const ref = `lt${t + 1}`;
		if (!push({ ref, kind: "tendency", text: row.text })) break;
		t++;
		refs[ref] = { namespace: "tendency", id: row.id, revision: row.revision };
	}
	const shortTerm: MemoryDescription["shortTerm"] = [];
	let n = 0;
	for (const item of deps.continuity.snapshotInTransaction(db, conversationId)
		.items) {
		const ref = `sn${++n}`;
		refs[ref] = {
			namespace: "continuity",
			id: item.id,
			revision: item.revision,
		};
		shortTerm.push({ ref, kind: item.kind, text: item.text });
	}
	return {
		refs,
		longTerm,
		shortTerm,
		recent,
		coverage: {
			stateTotal: stateItems.length,
			stateShown: m,
			tendenciesTotal: tendencies.length,
			tendenciesShown: t,
		},
	};
}

// ---- events ----

export type EventBy = "user" | "agent" | "specialist";
export type LoadedEvent = {
	/** The continuity event (`seq`); null for a message shown as context that no event stands for. */
	seq: number | null;
	/** The conversation message the event shows: the evidence of what a step saves, and what a forget blocks. */
	messageId: string | null;
	by: EventBy;
	origin: string | null;
	at: string;
	text: ClippedText;
	/** Bytes of the text the steward is shown. */
	bytes: number;
	/** sha256 of the message's full text when it was read (what a stored vector stands for). */
	digests: Record<string, string>;
};
export type LoadResult =
	| { status: "ok"; event: LoadedEvent }
	| { status: "gone" | "blocked" };

const roleOf = (by: EventBy) => (by === "user" ? "user" : "assistant");

/** The fields of a frozen event text (id, time, type, actor, then the event's own). */
function fieldsOf(event: ConversationEvent): Record<string, unknown> | null {
	if (event.text === null) return null;
	try {
		const parsed: unknown = JSON.parse(event.text);
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * One handled `said` event as the steward reads it: the words come from the conversation message the event shows
 * (the frozen text keeps only a head of a long utterance), or from the frozen text when no message stands behind
 * it (an announcement). `gone`: a forgotten event, a retracted message, an event with nothing to read; `blocked`:
 * a message of the block ledger (a scheduled prompt, a specialist session).
 */
export function loadEvent(env: StepEnv, event: ConversationEvent): LoadResult {
	const { db, deps, conversationId } = env;
	if (event.forgotten || event.type !== "said" || event.by === "host")
		return { status: "gone" };
	const by: EventBy = event.by;
	const fields = fieldsOf(event);
	const origin = typeof fields?.origin === "string" ? fields.origin : null;
	if (event.messageIds.length === 0) {
		const body = typeof fields?.text === "string" ? fields.text : null;
		if (body === null) return { status: "gone" };
		const clipped = clipMessage(body);
		return {
			status: "ok",
			event: {
				seq: event.seq,
				messageId: null,
				by,
				origin,
				at: event.at,
				text: clipped,
				bytes: byteLength(clipped.text),
				digests: {},
			},
		};
	}
	if (deps.memory.blockedMessageIdsInTransaction(db, event.messageIds).size > 0)
		return { status: "blocked" };
	const messageId = event.messageIds[0]!;
	const found = deps.conversation.messageInTransaction(db, messageId);
	if (
		!found ||
		found.message.role !== roleOf(by) ||
		found.message.conversationId !== conversationId
	)
		return { status: "gone" };
	const clipped = clipMessage(found.message.text);
	return {
		status: "ok",
		event: {
			seq: event.seq,
			messageId,
			by,
			origin,
			at: event.at,
			text: clipped,
			bytes: byteLength(clipped.text),
			digests: { [messageId]: sha256Hex(found.message.text) },
		},
	};
}

/** A conversation message as context for a request (the user's message it was made in), with no event behind it. */
export function loadMessage(env: StepEnv, messageId: string): LoadResult {
	const { db, deps, conversationId } = env;
	if (deps.memory.blockedMessageIdsInTransaction(db, [messageId]).size > 0)
		return { status: "blocked" };
	const found = deps.conversation.messageInTransaction(db, messageId);
	if (
		!found ||
		found.message.role !== "user" ||
		found.message.conversationId !== conversationId
	)
		return { status: "gone" };
	const clipped = clipMessage(found.message.text);
	return {
		status: "ok",
		event: {
			seq: null,
			messageId,
			by: "user",
			origin: null,
			at: found.message.createdAt,
			text: clipped,
			bytes: byteLength(clipped.text),
			digests: { [messageId]: sha256Hex(found.message.text) },
		},
	};
}

/** The model-facing view of an event. `reference`: it is shown only as context for a request. */
export function eventView(
	label: string,
	event: LoadedEvent,
	reference = false,
): Record<string, unknown> {
	return {
		id: label,
		at: event.at,
		by: event.by,
		...(event.origin ? { origin: event.origin } : {}),
		...(reference ? { reference: true } : {}),
		text: event.text.text,
		...(event.text.truncated ? { truncated: true } : {}),
	};
}

/** The event label table of a step: label -> the event and the message it stands on. */
export type LabelTable = Record<
	string,
	{ seq: number | null; messageId: string | null; by: EventBy }
>;

// ---- reading the model's output ----

export const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
/** A trimmed non-empty string within `max` characters, else null. */
export function text(value: unknown, max: number): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed !== "" && [...trimmed].length <= max ? trimmed : null;
}
/** A string for which `null`, an empty string or a wrong type mean "none". */
export function optionalText(value: unknown, max: number): string | null {
	return text(value, max);
}
export function oneOf<T extends string>(
	value: unknown,
	allowed: readonly T[],
): T | null {
	return typeof value === "string" &&
		(allowed as readonly string[]).includes(value)
		? (value as T)
		: null;
}
/** The array elements, each normalized by `read`; elements that do not read are dropped. */
export function elements<T>(
	value: unknown,
	read: (element: Record<string, unknown>) => T | null,
	limit: number,
): { items: T[]; dropped: number } {
	if (!Array.isArray(value)) return { items: [], dropped: 0 };
	const items: T[] = [];
	let dropped = 0;
	for (const element of value) {
		const read1 = isRecord(element) ? read(element) : null;
		if (read1 === null || items.length >= limit) dropped++;
		else items.push(read1);
	}
	return { items, dropped };
}
export function labels(value: unknown, limit = 16): string[] {
	if (!Array.isArray(value)) return [];
	return [
		...new Set(
			value.filter((x): x is string => typeof x === "string").slice(0, limit),
		),
	];
}
