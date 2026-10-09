import {
	closeSync,
	existsSync,
	fsyncSync,
	openSync,
	readFileSync,
	writeSync,
} from "node:fs";
import type { ForgetJournalEntry } from "eumenes-memory/sqlite";

/** Append-only forget journal kept outside the database (a restored old DB must not lose it). */
export function readJournal(path: string): ForgetJournalEntry[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as ForgetJournalEntry);
}
export function appendJournal(path: string, entry: ForgetJournalEntry) {
	const fd = openSync(path, "a", 0o600);
	try {
		writeSync(fd, `${JSON.stringify(entry)}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}
