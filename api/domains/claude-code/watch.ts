import type { Database } from "bun:sqlite";
import {
	appendBacklog,
	outputStream,
	type Listener,
} from "../../infrastructure/pty";
import type { SqliteStore } from "../../infrastructure/sqlite";
import { isStandardExecutionSource } from "../tool-runtime";
import type { Runner, Work } from "./contracts";
import { read, terminal } from "./repository";

/**
 * A work the conversation handed to Claude Code, shown read-only beside the terminal sessions
 * (spec claude-code-task-terminal-view-2026-11-25). The runner's tool events and Claude's own
 * words are the record; this only formats them into lines.
 */
export type WatchPane = {
	id: string;
	title: string;
	status: "running" | "exited";
	activity: "working" | "waiting" | "idle";
	startedAt: string;
	endedAt?: string;
	statusMessage?: string;
};

type Execution = {
	id: string;
	events: number;
	narration: number;
	opened: boolean;
	closed: boolean;
	/** Reads of the runner that failed in a row. */
	failures?: number;
};
type Session = {
	id: string;
	status: "running" | "exited";
	backlog: Uint8Array[];
	backlogSize: number;
	listeners: Set<Listener>;
	executions: Execution[];
	summary?: string;
	memo?: string;
	question?: string | null;
	queued?: boolean;
	idleSince?: number;
	/** One follow at a time: the poll and a new viewer never write the same lines twice. */
	chain?: Promise<void>;
};

const SHOWN_FINISHED = 3;
const BACKLOG_BYTES = 512 * 1024;
const POLL_MS = 1_000;
const KEEP_IDLE_MS = 5 * 60_000;
const RESULT_LINES = 6;
const LINE_CHARS = 200;
/** Failed reads in a row after which a finished work's execution is closed as unreadable. */
const GIVE_UP = 5;

const ESC = "\x1b";
const style = {
	dim: (s: string) => `${ESC}[2m${s}${ESC}[0m`,
	head: (s: string) => `${ESC}[1;36m${s}${ESC}[0m`,
	owner: (s: string) => `${ESC}[35m${s}${ESC}[0m`,
	ask: (s: string) => `${ESC}[1;33m${s}${ESC}[0m`,
	ok: (s: string) => `${ESC}[1;32m${s}${ESC}[0m`,
	ng: (s: string) => `${ESC}[1;31m${s}${ESC}[0m`,
	tool: (s: string) => `${ESC}[1m${s}${ESC}[0m`,
};

/** Text from a tool or the model never moves the cursor or recolours the pane. */
function clean(text: string): string {
	return (
		text
			// eslint-disable-next-line no-control-regex -- Escape sequences from a tool's output are removed.
			.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
			// eslint-disable-next-line no-control-regex -- Only newline and tab stay; C1 controls act like ESC in xterm.
			.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u2028\u2029]/g, "")
			.replace(/\t/g, "  ")
	);
}
const clip = (text: string, size: number) =>
	text.length > size ? `${text.slice(0, size)}…` : text;
const lines = (text: string) => clean(text.replace(/\r\n?/g, "\n")).split("\n");

/** Reads one JSON string field even from an event cut at its size limit. */
function field(raw: string, name: string): string | undefined {
	const match = new RegExp(`"${name}":"((?:[^"\\\\]|\\\\.)*)("|$)`).exec(raw);
	if (!match) return undefined;
	try {
		return JSON.parse(`"${match[1]!.replace(/\\$/, "")}"`) as string;
	} catch {
		return match[1];
	}
}

/** A path inside the working folder is shown from there. */
function shortPath(path: string, root?: string) {
	return root && path.startsWith(`${root}/`)
		? path.slice(root.length + 1)
		: path;
}

/** One tool event of the runner (`{tool, input, result}` JSON, possibly cut) as lines. */
export function toolLines(raw: string, root?: string): string[] {
	const named = field(raw, "tool");
	// The supervised path records plain text, not the tool's JSON.
	if (!named)
		return [`  ${style.tool("·")} ${clip(lines(raw)[0] ?? "", LINE_CHARS)}`];
	const tool = clean(named);
	const path = field(raw, "file_path") ?? field(raw, "notebook_path");
	const failure = field(raw, "error");
	const out = toolBody(raw, tool, path, root);
	if (failure)
		out.push(
			style.ng(`    ✗ ${clip(lines(failure).find(Boolean) ?? "", LINE_CHARS)}`),
		);
	return out;
}

function toolBody(
	raw: string,
	tool: string,
	path: string | undefined,
	root?: string,
): string[] {
	const out: string[] = [];
	if (tool === "Bash") {
		const command = lines(field(raw, "command") ?? "")[0] ?? "";
		out.push(`  ${style.tool("$")} ${clip(command, LINE_CHARS)}`);
		const stdout = field(raw, "stdout") ?? "";
		const stderr = field(raw, "stderr") ?? "";
		const shown = lines(stdout.trim() || stderr.trim()).filter(Boolean);
		for (const line of shown.slice(0, RESULT_LINES))
			out.push(style.dim(`    ${clip(line, LINE_CHARS)}`));
		if (shown.length > RESULT_LINES)
			out.push(style.dim(`    …（ほか ${shown.length - RESULT_LINES} 行）`));
		return out;
	}
	if (path) {
		const mark = /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool) ? "✎" : "·";
		out.push(
			`  ${style.tool(`${mark} ${tool}`)} ${clip(shortPath(clean(path), root), LINE_CHARS)}`,
		);
		return out;
	}
	const subject =
		field(raw, "pattern") ?? field(raw, "query") ?? field(raw, "url") ?? "";
	out.push(
		`  ${style.tool(`· ${tool}`)} ${clip(lines(subject)[0] ?? "", LINE_CHARS)}`.trimEnd(),
	);
	return out;
}

/** Claude's own words between tool calls. */
export function narrationLines(text: string): string[] {
	const said = lines(text.trim()).filter(Boolean);
	return said
		.slice(0, 8)
		.map(
			(line, i) => `  ${i ? "        " : "Claude: "}${clip(line, LINE_CHARS)}`,
		);
}

const time = (at: number) =>
	new Date(at).toLocaleTimeString("ja-JP", { hour12: false });

/** Progress lines the owner writes on every observation; the tool lines already show them. */
const routine = (summary: string) =>
	summary.startsWith("Claude Code が実行中です") ||
	summary === "依頼を受け付けました。";

const ENDED: Record<string, string> = {
	completed: "完了",
	partial: "一部完了",
	failed: "失敗",
	cancelled: "取消",
	interrupted: "中断",
};

/** Works the conversation handed over (not the supervised goal runs, which have their own view). */
const WATCHED = `json_extract(data,'$.source.delegation') IS NULL AND
 (json_extract(data,'$.source.origin') IS NULL OR json_extract(data,'$.source.origin') IN ('autonomous','workflow'))`;

function watchable(work: Work | null): work is Work {
	return !!work && !work.forgotten && isStandardExecutionSource(work.source);
}

function listInTransaction(db: Database): WatchPane[] {
	const rows = db
		.query<{ data: string; updated_at: number }, []>(
			`SELECT data, updated_at FROM claude_code_work WHERE ${WATCHED} ORDER BY updated_at DESC LIMIT 32`,
		)
		.all();
	const panes: WatchPane[] = [];
	let finished = 0;
	for (const row of rows) {
		const work = JSON.parse(row.data) as Work;
		if (!watchable(work)) continue;
		const ended = terminal(work);
		if (ended && ++finished > SHOWN_FINISHED) continue;
		panes.push({
			id: work.id,
			title: clip(lines(work.request)[0] ?? "", 60),
			status: ended ? "exited" : "running",
			activity: ended ? "idle" : work.question ? "waiting" : "working",
			startedAt: new Date(work.startedAt ?? work.observedAt).toISOString(),
			...(ended
				? {
						endedAt: new Date(row.updated_at).toISOString(),
						statusMessage: ENDED[work.status] ?? "終了",
					}
				: {}),
		});
	}
	// A fixed order: the screen keeps each pane's connection while the works move on.
	return panes.sort(
		(a, b) =>
			a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id),
	);
}

/** Grows by one with every work handed over (the screen opens when it does). */
function requestsInTransaction(db: Database): number {
	return (
		db
			.query<{ n: number }, []>(
				`SELECT COUNT(*) AS n FROM claude_code_work WHERE ${WATCHED}`,
			)
			.get()?.n ?? 0
	);
}

export function createWatch(input: {
	store: SqliteStore;
	runnerFor(work: Work): Runner | undefined;
	/** The working folder: paths inside it are shown relative to it. */
	root?: string;
	now?: () => number;
}) {
	const { store } = input;
	const now = input.now ?? Date.now;
	const sessions = new Map<string, Session>();
	const subscribers = new Set<() => void>();
	let timer: ReturnType<typeof setInterval> | undefined;
	let ticking: Promise<void> | undefined;
	let digest = "";
	let pendingCheck: ReturnType<typeof setTimeout> | undefined;

	function write(session: Session, text: string[]) {
		if (!text.length) return;
		const bytes = Buffer.from(`${text.join("\r\n")}\r\n`);
		appendBacklog(session, bytes, BACKLOG_BYTES);
		for (const listener of session.listeners) listener.data(bytes);
	}

	function end(session: Session) {
		session.status = "exited";
		for (const listener of session.listeners) listener.end();
		session.listeners.clear();
	}

	async function follow(session: Session) {
		const work = store.read((db) => read(db, session.id));
		if (!watchable(work)) {
			end(session);
			sessions.delete(session.id);
			return;
		}
		const runner = input.runnerFor(work);
		const ids = work.executionIds ?? [
			...new Set(
				[work.previousId, work.executionId].filter((id): id is string => !!id),
			),
		];
		for (const id of ids)
			if (!session.executions.some((e) => e.id === id))
				session.executions.push({
					id,
					events: 0,
					narration: 0,
					opened: false,
					closed: false,
				});
		if (!ids.length && work.status === "queued" && !session.queued) {
			session.queued = true;
			write(session, [style.dim(`… 作業場所の空き待ち（${time(now())}）`)]);
		}
		// Executions are written in order: the next one starts once the one before is fully written.
		let caughtUp = true;
		for (const [index, execution] of session.executions.entries()) {
			if (execution.closed) continue;
			if (!execution.opened) {
				execution.opened = true;
				write(session, [style.head(`▶ 実行 ${index + 1}`)]);
			}
			let drained = runner ? await drain(session, runner, execution) : true;
			// A finished work whose record cannot be read any more still ends its pane.
			if (!drained && terminal(work) && (execution.failures ?? 0) >= GIVE_UP) {
				write(session, [style.dim("  …この実行の記録を読めませんでした")]);
				drained = true;
			}
			const current = work.executionId === execution.id && !terminal(work);
			if (drained && !current) {
				execution.closed = true;
				const seen = await runner?.inspect(execution.id).catch(() => null);
				const detail = seen
					? [
							seen.resultSubtype,
							seen.turns !== undefined ? `${seen.turns} ターン` : "",
						]
							.filter(Boolean)
							.join("・")
					: "";
				write(session, [
					style.dim(`■ 実行 ${index + 1} 終了${detail ? `（${detail}）` : ""}`),
				]);
			}
			if (!drained) {
				caughtUp = false;
				break;
			}
			if (!execution.closed) break;
		}
		// The owner's decisions follow what Claude Code did up to now, not the middle of a replay.
		if (!caughtUp) return;
		const owner: string[] = [];
		if (work.memo && work.memo !== session.memo) {
			session.memo = work.memo;
			owner.push(
				style.owner(`担当メモ: ${clip(lines(work.memo).join(" "), 400)}`),
			);
		}
		if (work.summary !== session.summary) {
			session.summary = work.summary;
			if (!routine(work.summary) && !terminal(work))
				owner.push(
					style.owner(`担当: ${clip(lines(work.summary).join(" "), 400)}`),
				);
		}
		const question = work.question?.prompt ?? null;
		if (question !== (session.question ?? null)) {
			session.question = question;
			if (question)
				owner.push(
					style.ask(
						`？ ${clip(lines(question).join(" "), 400)}（会話で答えてください）`,
					),
				);
		}
		write(session, owner);
		if (terminal(work) && session.executions.every((e) => e.closed)) {
			const label = ENDED[work.status] ?? "終了";
			const text = clip(
				lines(work.result?.summary ?? work.summary).join(" "),
				600,
			);
			const paint = work.status === "completed" ? style.ok : style.ng;
			write(session, [paint(`━━ ${label}: ${text}`)]);
			end(session);
		}
	}

	/** Reads what is new of one execution; true when nothing more is waiting. */
	async function drain(session: Session, runner: Runner, execution: Execution) {
		if (!runner.events) return true;
		let fetched: Awaited<ReturnType<NonNullable<Runner["events"]>>>;
		try {
			fetched = await runner.events(execution.id, execution.events);
			execution.failures = 0;
		} catch {
			execution.failures = (execution.failures ?? 0) + 1;
			return false;
		}
		let said: { n: number; afterSeq: number; text: string }[] = [];
		if (runner.narration)
			try {
				said = (await runner.narration(execution.id, execution.narration))
					.items;
			} catch {
				said = [];
			}
		const last = fetched.events.at(-1)?.seq ?? execution.events;
		const out: string[] = [];
		const sayUpTo = (seq: number) => {
			while (said.length && said[0]!.afterSeq <= seq) {
				const item = said.shift()!;
				execution.narration = item.n;
				out.push(...narrationLines(item.text));
			}
		};
		for (const event of fetched.events) {
			sayUpTo(event.seq - 1);
			out.push(...toolLines(event.text, input.root));
			execution.events = event.seq;
		}
		sayUpTo(last);
		write(session, out);
		return fetched.events.length === 0 && said.length === 0;
	}

	function advance(session: Session): Promise<void> {
		const next = (session.chain ?? Promise.resolve()).then(() =>
			session.status === "running"
				? follow(session).catch(() => {})
				: undefined,
		);
		session.chain = next;
		return next;
	}

	async function tick() {
		for (const session of sessions.values()) {
			await advance(session);
			if (session.listeners.size) session.idleSince = undefined;
			else session.idleSince ??= now();
			if (
				session.idleSince !== undefined &&
				now() - session.idleSince > KEEP_IDLE_MS
			)
				sessions.delete(session.id);
		}
		if (!sessions.size && timer) {
			clearInterval(timer);
			timer = undefined;
		}
	}

	function poke() {
		if (ticking) return;
		ticking = tick().finally(() => {
			ticking = undefined;
		});
	}

	function watching() {
		if (timer) return;
		timer = setInterval(poke, POLL_MS);
		timer.unref?.();
	}

	function sessionOf(work: Work): Session {
		let session = sessions.get(work.id);
		if (!session) {
			session = {
				id: work.id,
				status: "running",
				backlog: [],
				backlogSize: 0,
				listeners: new Set(),
				executions: [],
			};
			sessions.set(work.id, session);
			write(session, [
				style.head(
					`━━ Claude Code（専任担当）  受付 ${time(work.startedAt ?? work.observedAt)}`,
				),
				`依頼: ${clip(lines(work.request).join(" "), 300)}`,
			]);
		}
		return session;
	}

	/** Tells the subscribers when the list of panes changed (a new work, a status, a question). */
	function check() {
		pendingCheck = undefined;
		let next = "";
		try {
			// Only what the list shows changes it: the rows are not parsed for this.
			next = JSON.stringify(
				store.read((db) =>
					db
						.query(
							`SELECT id, json_extract(data,'$.status'), json_type(data,'$.question'), json_extract(data,'$.forgotten')
							 FROM claude_code_work WHERE ${WATCHED} ORDER BY updated_at DESC LIMIT 32`,
						)
						.values(),
				),
			);
		} catch {
			return;
		}
		if (next === digest) return;
		digest = next;
		for (const listener of subscribers) listener();
	}

	return {
		listInTransaction,
		requestsInTransaction,
		/** Asked on every output and resize of the screen: one indexed row, not parsed. */
		hasInTransaction(db: Database, id: string) {
			return !!db
				.query(
					`SELECT 1 FROM claude_code_work WHERE id = ? AND ${WATCHED} AND json_extract(data,'$.forgotten') = 0`,
				)
				.get(id);
		},
		/**
		 * The pane's lines as server-sent events, like a terminal session (null: not a watched work).
		 * What the runner already recorded is written first, so a finished work shows in full.
		 */
		async stream(id: string, signal: AbortSignal): Promise<Response | null> {
			const work = store.read((db) => read(db, id));
			if (!watchable(work)) return null;
			const session = sessionOf(work);
			for (let round = 0; round < 32 && session.status === "running"; round++) {
				const before = session.backlogSize;
				await advance(session);
				if (session.backlogSize === before) break;
			}
			watching();
			return outputStream(session, signal, 15_000);
		},
		subscribe(listener: () => void) {
			subscribers.add(listener);
			const off = store.onCommit(() => {
				pendingCheck ??= setTimeout(check, 300);
				pendingCheck.unref?.();
			});
			return () => {
				subscribers.delete(listener);
				off();
			};
		},
		close() {
			clearInterval(timer);
			clearTimeout(pendingCheck);
			for (const session of sessions.values()) end(session);
			sessions.clear();
		},
	};
}

export type ClaudeCodeWatch = ReturnType<typeof createWatch>;
