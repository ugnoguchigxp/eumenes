import { classifyValidity, periodFromStateMs } from "eumenes-memory";
import type { StateItem } from "eumenes-memory/sqlite";
import { sha256Hex } from "../../../infrastructure/digest";
import { LONG_TERM_BYTES } from "../../memory";
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
	namespace: "state" | "tendency" | "continuity";
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
 * The long-term list (State, then tendencies) and the live notes, each with a short ref. The list is cut at
 * `LONG_TERM_BYTES`, newest first.
 */
export function describeMemory(env: StepEnv): MemoryDescription {
	const { db, deps, conversationId } = env;
	const refs: MemoryDescription["refs"] = {};
	const longTerm: MemoryDescription["longTerm"] = [];
	const recentIds = new Set(
		deps.memory.windows.storedInTransaction(db, conversationId)?.shortTerm
			.recentItemIds ?? [],
	);
	const recent: string[] = [];
	let bytes = 0;
	const push = (entry: Record<string, unknown>) => {
		const size = byteLength(JSON.stringify(entry));
		if (bytes + size > LONG_TERM_BYTES) return false;
		bytes += size;
		longTerm.push(entry);
		return true;
	};
	let m = 0;
	for (const item of activeStateItems(env)) {
		const ref = `m${m + 1}`;
		const entry: Record<string, unknown> = {
			ref,
			kind: item.kind,
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
	for (const row of deps.memory.tendencies()) {
		const ref = `t${t + 1}`;
		if (!push({ ref, kind: "tendency", text: row.text })) break;
		t++;
		refs[ref] = { namespace: "tendency", id: row.id, revision: row.revision };
	}
	const shortTerm: MemoryDescription["shortTerm"] = [];
	let n = 0;
	for (const item of deps.continuity.snapshotInTransaction(db, conversationId)
		.items) {
		const ref = `n${++n}`;
		refs[ref] = {
			namespace: "continuity",
			id: item.id,
			revision: item.revision,
		};
		shortTerm.push({ ref, kind: item.kind, text: item.text });
	}
	return { refs, longTerm, shortTerm, recent };
}

// ---- exchanges ----

export type LoadedExchange = {
	inputMessageId: string;
	answerMessageId: string | null;
	outcome: "answered" | "failed" | "request_only";
	ordinal: number;
	at: string;
	user: ClippedText;
	assistant: ClippedText | null;
	/** Bytes of the texts the steward is shown. */
	bytes: number;
	/** sha256 of each message's full text when it was read (what a stored vector stands for). */
	digests: Record<string, string>;
};
export type LoadResult =
	| { status: "ok"; exchange: LoadedExchange }
	| { status: "gone" | "blocked" };

/** One exchange as the steward reads it. `gone`: a message was retracted; `blocked`: it is on the block ledger. */
export function loadExchange(
	env: StepEnv,
	row: {
		inputMessageId: string;
		answerMessageId: string | null;
		outcome: "answered" | "failed" | "request_only";
	},
): LoadResult {
	const { db, deps, conversationId } = env;
	const ids = [row.inputMessageId, row.answerMessageId].filter(
		(id): id is string => id !== null,
	);
	if (deps.memory.blockedMessageIdsInTransaction(db, ids).size > 0)
		return { status: "blocked" };
	const user = deps.conversation.messageInTransaction(db, row.inputMessageId);
	if (
		!user ||
		user.message.role !== "user" ||
		user.message.conversationId !== conversationId
	)
		return { status: "gone" };
	let assistant: ReturnType<typeof deps.conversation.messageInTransaction> =
		null;
	if (row.answerMessageId !== null) {
		assistant = deps.conversation.messageInTransaction(db, row.answerMessageId);
		if (!assistant || assistant.message.role !== "assistant")
			return { status: "gone" };
	}
	const userText = clipMessage(user.message.text);
	const assistantText = assistant ? clipMessage(assistant.message.text) : null;
	return {
		status: "ok",
		exchange: {
			inputMessageId: row.inputMessageId,
			answerMessageId: row.answerMessageId,
			outcome: row.outcome,
			ordinal: user.ordinal,
			at: user.message.createdAt,
			user: userText,
			assistant: assistantText,
			bytes: byteLength(userText.text) + byteLength(assistantText?.text ?? ""),
			digests: {
				[row.inputMessageId]: sha256Hex(user.message.text),
				...(assistant && row.answerMessageId
					? { [row.answerMessageId]: sha256Hex(assistant.message.text) }
					: {}),
			},
		},
	};
}

/** The model-facing view of an exchange. `reference`: it is shown only as context for a request. */
export function exchangeView(
	label: string,
	exchange: LoadedExchange,
	reference = false,
): Record<string, unknown> {
	return {
		id: label,
		at: exchange.at,
		outcome:
			exchange.outcome === "failed"
				? "failed"
				: exchange.outcome === "request_only"
					? "user_only"
					: "answered",
		...(reference ? { reference: true } : {}),
		user: exchange.user.text,
		...(exchange.user.truncated ? { userTruncated: true } : {}),
		assistant: exchange.assistant?.text ?? null,
		...(exchange.assistant?.truncated ? { assistantTruncated: true } : {}),
	};
}

/** The exchange label table of a step: label -> the messages the exchange stands on. */
export type LabelTable = Record<
	string,
	{
		inputMessageId: string;
		answerMessageId: string | null;
		outcome: LoadedExchange["outcome"];
	}
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
