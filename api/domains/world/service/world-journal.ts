import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	fstatSync,
	fsyncSync,
	ftruncateSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	writeSync,
} from "node:fs";
import { dirname } from "node:path";
import type { ForgetRoot, TombstoneReasonCode } from "../repository/lifecycle";

/**
 * The World forget journal: a SEPARATE hash-chained JSONL file owned by the
 * host's World domain. Memory's own journal is never touched or extended.
 * Entries hold opaque ids only (never content): the forget id, the Memory
 * forget it belongs to, the Scope, the reason and the root ids. A database
 * restored from an older copy is reconciled against this file, so it must
 * outlive the database.
 */
export const WORLD_JOURNAL_FORMAT = 1 as const;
export const WORLD_GENESIS_HASH = "0".repeat(64);

export type WorldJournalEntry = {
	readonly journalFormat: typeof WORLD_JOURNAL_FORMAT;
	readonly seq: number;
	readonly prevHash: string;
	readonly forgetId: string;
	readonly memoryForgetId: string | null;
	readonly principal: string;
	readonly scopeKey: string;
	readonly reasonCode: TombstoneReasonCode;
	readonly roots: readonly ForgetRoot[];
	readonly hash: string;
};
export type WorldJournalDraft = Omit<
	WorldJournalEntry,
	"journalFormat" | "seq" | "prevHash" | "hash"
>;

export type WorldJournalFailure =
	| "unreadable"
	| "malformed"
	| "chain_broken"
	| "truncated";
/** The journal cannot be trusted. Callers keep World closed (fail closed). */
export class WorldJournalCorruptError extends Error {
	constructor(readonly code: WorldJournalFailure) {
		super(`world_journal_${code}`);
	}
}

const sha256 = (text: string) =>
	createHash("sha256").update(text).digest("hex");

/** Hash over every field except the hash itself, in a fixed order. */
export function hashEntry(entry: Omit<WorldJournalEntry, "hash">): string {
	return sha256(
		JSON.stringify([
			entry.journalFormat,
			entry.seq,
			entry.prevHash,
			entry.forgetId,
			entry.memoryForgetId,
			entry.principal,
			entry.scopeKey,
			entry.reasonCode,
			entry.roots.map((root) => [root.kind, root.id, root.revision]),
		]),
	);
}

const isRoot = (value: unknown): value is ForgetRoot => {
	if (typeof value !== "object" || value === null) return false;
	const r = value as Record<string, unknown>;
	return (
		typeof r["kind"] === "string" &&
		typeof r["id"] === "string" &&
		typeof r["revision"] === "number" &&
		Number.isSafeInteger(r["revision"])
	);
};
function parseEntry(line: string): WorldJournalEntry {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		throw new WorldJournalCorruptError("malformed");
	}
	const e = value as Record<string, unknown> | null;
	if (
		typeof e !== "object" ||
		e === null ||
		e["journalFormat"] !== WORLD_JOURNAL_FORMAT ||
		typeof e["seq"] !== "number" ||
		!Number.isSafeInteger(e["seq"]) ||
		typeof e["prevHash"] !== "string" ||
		typeof e["forgetId"] !== "string" ||
		!(
			e["memoryForgetId"] === null || typeof e["memoryForgetId"] === "string"
		) ||
		typeof e["principal"] !== "string" ||
		typeof e["scopeKey"] !== "string" ||
		typeof e["reasonCode"] !== "string" ||
		!Array.isArray(e["roots"]) ||
		!e["roots"].every(isRoot) ||
		typeof e["hash"] !== "string"
	)
		throw new WorldJournalCorruptError("malformed");
	return e as unknown as WorldJournalEntry;
}

/** Chain check: seq 1.., prevHash links, every hash recomputed. */
export function verifyWorldJournal(
	entries: readonly WorldJournalEntry[],
): void {
	let prev = WORLD_GENESIS_HASH;
	const ids = new Set<string>();
	entries.forEach((entry, index) => {
		if (
			entry.seq !== index + 1 ||
			entry.prevHash !== prev ||
			hashEntry(entry) !== entry.hash ||
			ids.has(entry.forgetId)
		)
			throw new WorldJournalCorruptError("chain_broken");
		ids.add(entry.forgetId);
		prev = entry.hash;
	});
}

/**
 * Reads and verifies the whole journal. A missing file is an empty journal
 * (the caller decides whether the database expects entries). A torn last line
 * is corruption, not silently dropped.
 */
export function readWorldJournal(path: string): WorldJournalEntry[] {
	if (!existsSync(path)) return [];
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		throw new WorldJournalCorruptError("unreadable");
	}
	if (text.length > 0 && !text.endsWith("\n"))
		throw new WorldJournalCorruptError("malformed");
	const entries = text
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map(parseEntry);
	verifyWorldJournal(entries);
	return entries;
}

/**
 * Newline-terminated, fsynced append of the next chained entry; the directory
 * is fsynced when the file is created. A failed write is truncated back so
 * no torn line stays. Idempotent per forgetId: an id that is already in the
 * journal returns its entry unchanged (a crash may repeat the append).
 */
export function appendWorldJournal(
	path: string,
	draft: WorldJournalDraft,
): WorldJournalEntry {
	const existing = readWorldJournal(path);
	const found = existing.find((entry) => entry.forgetId === draft.forgetId);
	if (found) return found;
	const head = existing[existing.length - 1];
	const unsigned = {
		journalFormat: WORLD_JOURNAL_FORMAT,
		seq: (head?.seq ?? 0) + 1,
		prevHash: head?.hash ?? WORLD_GENESIS_HASH,
		...draft,
	} as const;
	const entry: WorldJournalEntry = { ...unsigned, hash: hashEntry(unsigned) };
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const created = !existsSync(path);
	const fd = openSync(path, "a", 0o600);
	const before = fstatSync(fd).size;
	try {
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
			/* The next startup reports a corrupt journal and keeps World closed. */
		}
		throw error;
	} finally {
		closeSync(fd);
	}
	return entry;
}

export function journalHead(
	entries: readonly WorldJournalEntry[],
): { seq: number; hash: string } | null {
	const head = entries[entries.length - 1];
	return head ? { seq: head.seq, hash: head.hash } : null;
}
