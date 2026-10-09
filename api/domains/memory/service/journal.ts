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

/** Thrown for an unreadable journal; callers treat it as "memory unusable" (fail closed). */
export class JournalCorruptError extends Error {
	constructor() {
		super("journal_corrupt");
	}
}
/** Append-only forget journal kept outside the database (a restored old DB must not lose it). */
export function readJournal(path: string): ForgetJournalEntry[] {
	if (!existsSync(path)) return [];
	try {
		return readFileSync(path, "utf8")
			.split("\n")
			.filter((line) => line.trim() !== "")
			.map((line) => JSON.parse(line) as ForgetJournalEntry);
	} catch {
		throw new JournalCorruptError();
	}
}
/** Newline-terminated, fsynced append. A failed write is truncated back so no torn line is left. */
export function appendJournal(path: string, entry: ForgetJournalEntry) {
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
