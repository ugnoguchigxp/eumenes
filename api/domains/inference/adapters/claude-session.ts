import type {
	SessionStore,
	SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import { lstat, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Messages } from "../contracts";

/**
 * Where the host's messages split for a Claude Agent SDK session. The caller (dialogue) fixes this by position:
 * the first `instructionCount` messages are the instructions (system prompt), and the first `historyCount`
 * user/assistant messages after them are the history the session resumes from. Every other message
 * (working memory, notices, operation results, the current input, a correction) is this turn's input, in order.
 */
export type ContextSplit = { instructionCount: number; historyCount: number };
export type Turn = { role: "user" | "assistant"; content: string };

export function splitMessages(
	messages: Messages,
	context: ContextSplit | undefined,
	invalid: () => Error,
) {
	let instructionEnd = 0;
	if (context) {
		instructionEnd = context.instructionCount;
		if (
			!Number.isSafeInteger(instructionEnd) ||
			instructionEnd < 0 ||
			instructionEnd > messages.length ||
			messages.slice(0, instructionEnd).some((m) => m.role !== "system")
		)
			throw invalid();
	} else
		while (
			instructionEnd < messages.length &&
			messages[instructionEnd]!.role === "system"
		)
			instructionEnd++;
	const rest = messages.slice(instructionEnd);
	const wanted = context?.historyCount ?? 0;
	if (!Number.isSafeInteger(wanted) || wanted < 0) throw invalid();
	const history: Turn[] = [];
	const turn: Messages = [];
	for (const message of rest) {
		if (history.length < wanted && message.role !== "system")
			history.push({
				role: message.role as Turn["role"],
				content: message.content,
			});
		else turn.push(message);
	}
	if (history.length < wanted) throw invalid();
	return {
		instructions: messages.slice(0, instructionEnd).map((m) => m.content),
		history,
		turn,
	};
}

/**
 * The first turn must come from the user, and a run of one role is one message (the API merges them anyway).
 * A history that ends on a user turn nobody answered (a run that failed or was cancelled) would make the CLI's
 * resume insert a synthetic assistant turn for the interrupted one, so that turn leaves the history as `pending`
 * and the caller puts it in front of this turn's input.
 */
export function normalizeHistory(history: readonly Turn[]): {
	turns: Turn[];
	pending: Turn[];
} {
	const turns: Turn[] = [];
	for (const turn of history) {
		if (!turn.content.trim()) continue;
		const last = turns.at(-1);
		if (last?.role === turn.role)
			last.content = `${last.content}\n\n${turn.content}`;
		else if (last || turn.role === "user") turns.push({ ...turn });
	}
	return {
		turns,
		pending: turns.at(-1)?.role === "user" ? [turns.pop()!] : [],
	};
}

/** The CLI version the entry shape below was captured from (P0); the golden test pins the shape. */
const ENTRY_VERSION = "2.1.289";
const BASE_TIME = Date.parse("2026-01-01T00:00:00.000Z");

/**
 * The CLI's transcript entries for a history, rebuilt from the host's own record: a single `parentUuid` chain of
 * user and assistant text turns, deterministic so an unchanged history prefix is byte-identical across calls.
 */
export function transcriptEntries(
	sessionId: string,
	history: readonly Turn[],
	opts: { cwd: string; model: string },
): SessionStoreEntry[] {
	const entries: SessionStoreEntry[] = [];
	let parent: string | null = null;
	const common = {
		isSidechain: false,
		sessionId,
		userType: "external",
		entrypoint: "sdk-ts",
		cwd: opts.cwd,
		version: ENTRY_VERSION,
		gitBranch: "HEAD",
	};
	history.forEach((turn, index) => {
		const uuid = `aaaaaaaa-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`;
		const timestamp = new Date(BASE_TIME + index * 1000).toISOString();
		const content = [{ type: "text", text: turn.content }];
		const message =
			turn.role === "user"
				? { role: "user", content }
				: {
						id: `msg_history_${index + 1}`,
						type: "message",
						role: "assistant",
						model: opts.model,
						content,
						stop_reason: "end_turn",
						stop_sequence: null,
						usage: {
							input_tokens: 0,
							cache_creation_input_tokens: 0,
							cache_read_input_tokens: 0,
							output_tokens: 0,
						},
					};
		entries.push({
			parentUuid: parent,
			...common,
			type: turn.role,
			message,
			uuid,
			timestamp,
		});
		parent = uuid;
	});
	return entries;
}

/**
 * The store handed to `query()`. `load` answers with the host's history only; `append` receives the SDK's own
 * record of the call and drops it (the conversation ledger, not the SDK's transcript, is the history).
 */
export function hostHistoryStore(input: {
	sessionId: string;
	entries: SessionStoreEntry[];
	onDelete: () => Promise<void>;
}): SessionStore {
	return {
		async append() {},
		async load(key) {
			return key.sessionId === input.sessionId && key.subpath === undefined
				? input.entries
				: null;
		},
		async delete(key) {
			if (key.sessionId === input.sessionId && key.subpath === undefined)
				await input.onDelete();
		},
	};
}

export const AGENT_ROOT_PREFIX = "eumenes-agent-";
const RESUME_DIR = /^claude-resume-[0-9a-f-]{36}$/;
/** Roots of the calls running in this process, with the time each started. */
const live = new Map<string, number>();
export const trackClaudeRoot = (root: string) => {
	live.set(root, Date.now());
	return () => live.delete(root);
};

/** The project keys the host gives the SDK sessions it stores (`claude-resume-*` holds `projects/<key>`). */
const HOST_PROJECT_KEYS = ["eumenes-main", "eumenes-subagent"];
/** A directory younger than this (by its newest file) may belong to a call still running in another process. */
const SWEEP_MIN_AGE_MS = 60 * 60_000;

/** The newest modification time under a directory (itself included), looked at recursively. */
async function newestMtime(path: string): Promise<number> {
	const info = await lstat(path);
	let newest = info.mtimeMs;
	if (!info.isDirectory()) return newest;
	for (const name of await readdir(path))
		newest = Math.max(newest, await newestMtime(join(path, name)));
	return newest;
}

async function madeByHost(path: string): Promise<boolean> {
	for (const key of HOST_PROJECT_KEYS)
		try {
			if ((await lstat(join(path, "projects", key))).isDirectory()) return true;
		} catch {
			// not this key
		}
	return false;
}

/**
 * Removes what an abnormal exit leaves behind: per-call roots (`eumenes-agent-*`) and the CLI's `claude-resume-*`
 * copies of a resumed history, which the SDK writes into the host's temporary directory. A `claude-resume-*`
 * directory is only taken when it holds one of the host's own project keys (another program's is never ours).
 * Nothing a call running in this process can own is removed, and nothing whose newest file is younger than
 * `minAgeMs` (another process may own it).
 */
export async function sweepClaudeTemp(
	minAgeMs = SWEEP_MIN_AGE_MS,
	dir = tmpdir(),
	now = Date.now(),
): Promise<number> {
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return 0;
	}
	const cutoff = Math.min(now - minAgeMs, ...live.values());
	let removed = 0;
	for (const name of names) {
		const agentRoot = name.startsWith(AGENT_ROOT_PREFIX);
		if (!agentRoot && !RESUME_DIR.test(name)) continue;
		const path = join(dir, name);
		if (live.has(path)) continue;
		try {
			const info = await lstat(path);
			if (!info.isDirectory()) continue;
			if (!agentRoot && !(await madeByHost(path))) continue;
			if ((await newestMtime(path)) >= cutoff) continue;
			await rm(path, { recursive: true, force: true });
			removed++;
		} catch {
			// a directory that vanished or can not be read is not ours to keep trying
		}
	}
	return removed;
}
