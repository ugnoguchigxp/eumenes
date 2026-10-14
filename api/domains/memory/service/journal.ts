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
	writeSync,
} from "node:fs";
import type { ForgetJournalEntry } from "eumenes-memory/sqlite";
import type { ForgetDerived } from "../contracts";

/** One line of the block journal: the intent of a forget, written before the database is touched. */
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
/** `<name>.blocks.jsonl` next to the forget journal (`<name>.jsonl`): the library validates the forget journal, so nothing else may enter it. */
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
