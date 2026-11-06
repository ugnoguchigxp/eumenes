import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import {
	closeSync,
	existsSync,
	fstatSync,
	fsyncSync,
	ftruncateSync,
	openSync,
	readFileSync,
	readSync,
	renameSync,
	writeSync,
} from "node:fs";
import type {
	ForgetJournalEntry,
	HostForgetIntent,
} from "eumenes-memory/sqlite";
import type { ForgetDerived } from "../contracts";

/**
 * What a forget means for memory's own data: the messages that leave the context, the State items (every version)
 * and the other domains' derived ids. It rides in the forget journal entry's `hostIntent`, so the library's hash
 * chain covers it (the separate block journal of earlier versions had no chain).
 */
export interface ForgetIntent {
	conversationId: string;
	messageIds: string[];
	itemIds: string[];
	derived?: ForgetDerived;
	/** The forgetId of the block journal line this intent was imported from (absent for intents written directly). */
	legacyBlockForgetId?: string;
}
const INTENT_KEYS = {
	conversation: "memory.conversation",
	messages: "memory.messages",
	items: "memory.items",
	legacyBlock: "memory.legacy-block",
} as const;
/** Other domains' `derived` names go under this prefix, apart from memory's own keys. */
const DERIVED_PREFIX = "derived:";

/** The `hostIntent` of a forget journal entry (ids only; the library sorts and dedupes them and drops empty lists). */
export function hostIntentOf(intent: ForgetIntent): HostForgetIntent {
	const hostIntent: Record<string, readonly string[]> = Object.create(null);
	if (intent.conversationId !== "")
		hostIntent[INTENT_KEYS.conversation] = [intent.conversationId];
	hostIntent[INTENT_KEYS.messages] = intent.messageIds;
	hostIntent[INTENT_KEYS.items] = intent.itemIds;
	if (intent.legacyBlockForgetId !== undefined)
		hostIntent[INTENT_KEYS.legacyBlock] = [intent.legacyBlockForgetId];
	for (const [name, ids] of Object.entries(intent.derived ?? {}))
		hostIntent[`${DERIVED_PREFIX}${name}`] = ids;
	return hostIntent;
}
/** The intent a `hostIntent` carries (lists that were empty come back empty; no derived name comes back as none). */
export function intentOf(hostIntent: HostForgetIntent): ForgetIntent {
	// Lines read leniently (for hiding) may hold anything: only string lists count.
	const list = (value: unknown): string[] =>
		Array.isArray(value)
			? value.filter((id): id is string => typeof id === "string")
			: [];
	const record: Record<string, unknown> =
		typeof hostIntent === "object" && hostIntent !== null ? hostIntent : {};
	// null-prototype: a derived name such as `__proto__` stays an own property.
	const derived: Record<string, readonly string[]> = Object.create(null);
	for (const [key, ids] of Object.entries(record))
		if (key.startsWith(DERIVED_PREFIX))
			derived[key.slice(DERIVED_PREFIX.length)] = list(ids);
	const legacy = list(record[INTENT_KEYS.legacyBlock])[0];
	return {
		conversationId: list(record[INTENT_KEYS.conversation])[0] ?? "",
		messageIds: list(record[INTENT_KEYS.messages]),
		itemIds: list(record[INTENT_KEYS.items]),
		...(Object.keys(derived).length > 0 ? { derived } : {}),
		...(legacy !== undefined ? { legacyBlockForgetId: legacy } : {}),
	};
}
/** The intents of the journal's entries, in journal order. */
export function intentsOf(
	entries: readonly ForgetJournalEntry[],
): Array<{ forgetId: string; intent: ForgetIntent }> {
	return entries.flatMap((entry) =>
		entry.hostIntent
			? [{ forgetId: entry.forgetId, intent: intentOf(entry.hostIntent) }]
			: [],
	);
}

/**
 * Every line that parses, skipping the ones that do not: for hiding messages only (hiding more than the database
 * knows is the safe side). Reconciliation reads with `readJournal`, which refuses a damaged journal.
 */
export function readJournalLenient<T = ForgetJournalEntry>(path: string): T[] {
	if (!existsSync(path)) return [];
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return [];
	}
	return text.split("\n").flatMap((line) => {
		if (line.trim() === "") return [];
		try {
			return [JSON.parse(line) as T];
		} catch {
			return [];
		}
	});
}

/** Moves a journal aside (`<path>.imported`, or `.imported.<n>` when that exists) and makes the rename durable. */
export function setJournalAside(path: string): void {
	let target = `${path}.imported`;
	for (let n = 1; existsSync(target); n++) target = `${path}.imported.${n}`;
	renameSync(path, target);
	const dir = openSync(dirname(path), "r");
	try {
		fsyncSync(dir);
	} finally {
		closeSync(dir);
	}
}

/**
 * One line of the block journal of earlier versions: the intent of a forget, written before the database was
 * touched. New forgets carry their intent in the forget journal (`ForgetIntent`); startup imports these lines once.
 */
export interface BlockJournalEntry {
	forgetId: string;
	conversationId: string;
	/** Messages that must never be used for memory or context again. */
	messageIds: string[];
	/** State items to forget (every version of the facts). */
	itemIds: string[];
	/** Opaque ids of other domains' derived data (see `ForgetDerived`); absent on lines written without any. */
	derived?: ForgetDerived;
	at: string;
}
/** `<name>.blocks.jsonl` next to the forget journal (`<name>.jsonl`): where earlier versions kept the block journal (imported once at startup). */
export function blockJournalPathOf(journalPath: string): string {
	return journalPath.endsWith(".jsonl")
		? `${journalPath.slice(0, -".jsonl".length)}.blocks.jsonl`
		: `${journalPath}.blocks`;
}

/** Thrown for an unreadable journal; callers treat it as "memory unusable" (fail closed). */
class JournalCorruptError extends Error {
	constructor() {
		super("journal_corrupt");
	}
}
/** Append-only journal kept outside the database (a restored old DB must not lose it): the forget journal or the block journal. */
export function readJournal<T = ForgetJournalEntry>(path: string): T[] {
	if (!existsSync(path)) return [];
	try {
		return readFileSync(path, "utf8")
			.split("\n")
			.filter((line) => line.trim() !== "")
			.map((line) => JSON.parse(line) as T);
	} catch {
		throw new JournalCorruptError();
	}
}
/** Newline-terminated, fsynced append. A failed write is truncated back so no torn line is left. */
export function appendJournal<T = ForgetJournalEntry>(path: string, entry: T) {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const created = !existsSync(path);
	const fd = openSync(path, "a", 0o600);
	const before = fstatSync(fd).size;
	try {
		// A complete last line that lacks its newline must not be glued to the new entry.
		let prefix = "";
		if (before > 0) {
			const reader = openSync(path, "r");
			try {
				const last = Buffer.alloc(1);
				readSync(reader, last, 0, 1, before - 1);
				if (last[0] !== 0x0a) prefix = "\n";
			} finally {
				closeSync(reader);
			}
		}
		writeSync(fd, `${prefix}${JSON.stringify(entry)}\n`);
		fsyncSync(fd);
		if (created) {
			// Make the new file's directory entry durable too.
			const dir = openSync(dirname(path), "r");
			try {
				fsyncSync(dir);
			} finally {
				closeSync(dir);
			}
		}
	} catch (error) {
		try {
			ftruncateSync(fd, before);
		} catch {
			/* The next startup reports a corrupt journal and disables memory. */
		}
		throw error;
	} finally {
		closeSync(fd);
	}
}
