import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type SqliteStore } from "../../../infrastructure/sqlite";
import type { EnqueueRequest } from "../contracts";
import { migrations } from "../repository";
import { createTerminals } from "../service";
import { type HookPayload, headerFileOf } from "../hooks";
import type { SpawnPty, TerminalsOptions } from "../types";

/** What the fake PTY did, with the facts a test needs read at spawn time. */
export type Spawned = {
	command: readonly string[];
	cwd?: string;
	writes: string[];
	sizes: Array<{ cols: number; rows: number }>;
	signals: string[];
	killed: boolean;
	closed: boolean;
	onData(bytes: Uint8Array): void;
	exit(code: number | null): void;
	/** Terminal session id, hook token and settings (null without hooks), read when spawned. */
	sessionId?: string;
	token?: string;
	settings?: {
		hooks: Record<string, unknown>;
		permissions?: { deny: string[] };
	};
	/** The conversation id the command was launched with. */
	claudeId: string;
	resume: boolean;
};

export function fakePty(
	behavior: {
		/** Signals the fake process ignores (it keeps running). */
		ignore?: Array<"SIGTERM" | "SIGKILL">;
		/** Runs when a PTY is spawned; may throw to fail the launch. */
		onSpawn?(spawned: Spawned): void;
		failWrites?: boolean;
	} = {},
) {
	const spawned: Spawned[] = [];
	const spawn: SpawnPty = ({ command, size, cwd, onData }) => {
		let exit!: (code: number | null) => void;
		const exited = new Promise<number | null>((resolve) => {
			exit = resolve;
		});
		const settingsPath = command[command.indexOf("--settings") + 1];
		const settingsText =
			command.includes("--settings") && settingsPath
				? readFileSync(settingsPath, "utf8")
				: undefined;
		const flag = command.findIndex(
			(a) => a === "--session-id" || a === "--resume",
		);
		const entry: Spawned = {
			command,
			cwd,
			writes: [],
			sizes: [size],
			signals: [],
			killed: false,
			closed: false,
			onData,
			exit,
			claudeId: command[flag + 1]!,
			resume: command[flag] === "--resume",
			...(settingsText
				? {
						settings: JSON.parse(settingsText),
						token: /x-eumenes-hook-token: ([0-9a-f]{64})/.exec(
							readFileSync(headerFileOf(settingsPath!), "utf8"),
						)![1]!,
						sessionId: /hooks\/terminals\/([0-9a-f-]{36})/.exec(
							settingsText,
						)![1]!,
					}
				: {}),
		};
		behavior.onSpawn?.(entry);
		spawned.push(entry);
		return {
			write(data) {
				if (behavior.failWrites) throw new Error("write_failed");
				entry.writes.push(data);
			},
			resize: (next) => entry.sizes.push(next),
			kill(signal) {
				if (signal) entry.signals.push(signal);
				else {
					entry.killed = true;
					exit(null);
					return;
				}
				if (!behavior.ignore?.includes(signal)) exit(null);
			},
			close: () => {
				entry.closed = true;
			},
			exited,
		};
	};
	return { spawn, spawned };
}

/** A fresh queue table (stub of the queue migration it follows) plus the terminals one. */
export function openTestStore() {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-terminals-"));
	const store = openStore(join(dir, "db"), [
		{ id: "queue/0001-init", sql: "CREATE TABLE queue_stub (id TEXT)" },
		...migrations,
	]);
	return {
		dir,
		store,
		async close() {
			await store.close().catch(() => {});
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

let counter = 0;
export const requestOf = (
	over: Partial<EnqueueRequest> = {},
): EnqueueRequest => ({
	attemptId: crypto.randomUUID(),
	owner: "kanban:card-1",
	target: "new",
	mode: "work",
	projectId: "eumenes",
	prompt: `作業 ${++counter}`,
	task: `タスク${counter}`,
	origin: "board",
	exclusiveGroup: "kanban",
	...over,
});

/** Terminals over a real SQLite store and fake PTYs, with the hook calls a test makes. */
export function hooked(
	options: Partial<TerminalsOptions> = {},
	pty = fakePty(),
	storeOverride?: (store: SqliteStore) => SqliteStore,
) {
	const db = openTestStore();
	const store = storeOverride ? storeOverride(db.store) : db.store;
	const terminals = createTerminals({
		command: ["claude"],
		spawn: pty.spawn,
		store,
		hookBaseUrl: "http://127.0.0.1:8787",
		curl: "curl",
		submitDelayMs: 0,
		sweepMs: 3_600_000,
		trackingMs: 10_000,
		manualInputWaitMs: 40,
		cwd: db.dir,
		...options,
	});
	/** Startup recovery has run, as the host does before it lets anything be sent. */
	const ready = terminals.recover();
	const harness = {
		...db,
		ready,
		store,
		terminals,
		pty,
		spawned: pty.spawned,
		/** Saves a request as a caller would (its own writer transaction) and lets the sender run. */
		async enqueue(over: Partial<EnqueueRequest> = {}) {
			const request = requestOf(over);
			await ready;
			await store.write((tx) => terminals.enqueueInTransaction(tx, request));
			await terminals.settled();
			return request;
		},
		view: (id: string) =>
			store.read((db) => terminals.requestInTransaction(db, id)),
		state: (id: string) => harness.view(id)?.state,
		/** One hook as Claude Code sends it, for the n-th spawned PTY. */
		async hook(
			n: number,
			payload: Omit<HookPayload, "session_id"> & { session_id?: string },
		) {
			const spawned = pty.spawned[n]!;
			await terminals.hook(spawned.sessionId!, spawned.token!, {
				session_id: spawned.claudeId,
				...payload,
			} as HookPayload);
			await terminals.settled();
		},
		/** SessionStart and the turn of a request begin, as a real run reports them. */
		async begin(n: number, promptId: string, prompt: string) {
			await harness.hook(n, {
				hook_event_name: "SessionStart",
				source: "startup",
			});
			await harness.hook(n, {
				hook_event_name: "UserPromptSubmit",
				prompt_id: promptId,
				prompt,
			});
		},
		async finish() {
			terminals.closeAll();
			await db.close();
		},
	};
	return harness;
}

export async function until(condition: () => boolean, ms = 2000) {
	const end = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > end) throw new Error("until_timeout");
		await Bun.sleep(5);
	}
}
