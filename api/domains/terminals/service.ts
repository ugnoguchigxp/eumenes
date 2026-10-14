import { getLogger } from "../../infrastructure/logger";
import type {
	TerminalActivity,
	TerminalSessionView,
	TerminalSessionsView,
	TerminalStatus,
} from "./contracts";
import { type Listener, outputStream } from "./stream";
import {
	type HookPayload,
	hookSettings,
	LAST_MESSAGE_CHARS,
	newHookToken,
	sameToken,
} from "./hooks";

export type TerminalSize = { cols: number; rows: number };

/** A spawned PTY process. Its output arrives through `onData` given at spawn. */
export type Pty = {
	write(data: string): void;
	resize(size: TerminalSize): void;
	kill(): void;
	/** Releases the PTY after the process exited. */
	close(): void;
	/** Resolves with the process exit code (null when it was signalled). */
	exited: Promise<number | null>;
};
export type SpawnPty = (request: {
	command: readonly string[];
	size: TerminalSize;
	onData(bytes: Uint8Array): void;
}) => Pty;

export type TerminalsOptions = {
	/** The fixed program; null when it is not installed. Defaults to `claude` on PATH. */
	command?: readonly string[] | null;
	cwd?: string;
	spawn?: SpawnPty;
	limit?: number;
	/** Output kept per session so a reopened screen shows the current state. */
	backlogBytes?: number;
	/** Live output streams per session (several tabs may watch one session). */
	streamsPerSession?: number;
	heartbeatMs?: number;
	/** Pause between pasting a request and pressing Enter, so the TUI takes the paste first. */
	submitDelayMs?: number;
	/**
	 * Loopback base URL of this server (e.g. `http://127.0.0.1:8787`). When set, every run gets
	 * Claude Code hooks that report its progress here; without it, no activity is known.
	 */
	hookBaseUrl?: string;
	/** A session or its activity changed (the host publishes a change event). */
	onChange?: () => void;
	now?: () => Date;
};

/** A task handed over from the conversation that Claude Code finished (its Stop hook). */
export type TaskFinished = {
	sessionId: string;
	run: number;
	task: string;
	conversationId?: string;
	/** Claude Code's last answer, cut to a bounded length; data, never instructions. */
	lastMessage: string;
};

/** Size of a session started without a screen (from the conversation) until a pane fits it. */
export const DEFAULT_TERMINAL_SIZE: TerminalSize = { cols: 120, rows: 32 };

/** Bracketed paste keeps a multi-line request one input instead of a line per Enter. */
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

type Session = {
	id: string;
	title: string;
	status: TerminalStatus;
	run: number;
	exitCode?: number | null;
	startedAt: string;
	endedAt?: string;
	pty: Pty;
	size: TerminalSize;
	activity: TerminalActivity;
	task?: { name: string; conversationId?: string };
	hookToken?: string;
	backlog: Uint8Array[];
	backlogSize: number;
	listeners: Set<Listener>;
};

const log = getLogger("terminals");

/** Color settings of the server's own (non-terminal) output; the child gets a full-color xterm. */
const SERVER_ONLY = new Set(["NO_COLOR", "FORCE_COLOR"]);
/**
 * Markers of a Claude Code session that started this server (e.g. `bun run dev` run by an agent).
 * A screen session is the person's own top-level session, so it must not look like its child.
 */
const PARENT_SESSION = new Set([
	"CLAUDECODE",
	"CLAUDE_PID",
	"CLAUDE_EFFORT",
	"CLAUDE_CODE_CHILD_SESSION",
	"CLAUDE_CODE_ENTRYPOINT",
	"CLAUDE_CODE_EXECPATH",
]);
const PARENT_SESSION_PREFIXES = [
	"EUMENES_",
	"CLAUDE_CODE_MESSAGING_",
	"CLAUDE_CODE_SESSION_",
];
const inherited = (key: string) =>
	!SERVER_ONLY.has(key) &&
	!PARENT_SESSION.has(key) &&
	!PARENT_SESSION_PREFIXES.some((prefix) => key.startsWith(prefix));

/**
 * The server's environment without Eumenes' own secrets (API token, keys, database), the
 * server's color settings, and the markers of a Claude Code session that launched the server.
 */
export function childEnv(
	env: Record<string, string | undefined>,
): Record<string, string | undefined> {
	return {
		...Object.fromEntries(
			Object.entries(env).filter(([key]) => inherited(key)),
		),
		TERM: "xterm-256color",
		COLORTERM: "truecolor",
	};
}

/** Spawns through Bun's PTY support (POSIX only). The child sees a real xterm-256color terminal. */
export function bunSpawnPty(
	cwd: string | undefined,
	env: Record<string, string | undefined> = process.env,
): SpawnPty {
	return ({ command, size, onData }) => {
		const proc = Bun.spawn([...command], {
			cwd,
			env: childEnv(env),
			terminal: {
				cols: size.cols,
				rows: size.rows,
				name: "xterm-256color",
				data: (_terminal, bytes) => onData(bytes),
			},
		});
		return {
			write: (data) => proc.terminal?.write(data),
			resize: ({ cols, rows }) => proc.terminal?.resize(cols, rows),
			kill: () => {
				proc.kill();
				proc.terminal?.close();
			},
			close: () => proc.terminal?.close(),
			exited: proc.exited.then(
				() => proc.exitCode,
				() => null,
			),
		};
	};
}

function defaultCommand(): readonly string[] | null {
	const path = Bun.which("claude");
	return path ? [path] : null;
}

/**
 * PTY sessions of one fixed command, held in memory by this process. Sessions end with the
 * server; nothing is saved. Terminal input and output never reach the log.
 */
export function createTerminals(options: TerminalsOptions = {}) {
	const command =
		options.command === undefined ? defaultCommand() : options.command;
	const spawn = options.spawn ?? bunSpawnPty(options.cwd);
	const limit = options.limit ?? 4;
	const backlogBytes = options.backlogBytes ?? 512 * 1024;
	const streamsPerSession = options.streamsPerSession ?? 4;
	const now = options.now ?? (() => new Date());
	const sessions = new Map<string, Session>();
	let revision = 0;
	let opened = 0;
	let requests = 0;
	const finished = new Set<(event: TaskFinished) => void>();
	const changed = () => {
		revision += 1;
		options.onChange?.();
	};

	const view = (s: Session): TerminalSessionView => ({
		id: s.id,
		title: s.title,
		status: s.status,
		run: s.run,
		...(s.status === "running" ? { activity: s.activity } : {}),
		...(s.task ? { task: s.task.name } : {}),
		...(s.exitCode !== undefined ? { exitCode: s.exitCode } : {}),
		startedAt: s.startedAt,
		...(s.endedAt ? { endedAt: s.endedAt } : {}),
	});
	const find = (id: string) => {
		const session = sessions.get(id);
		if (!session) throw new Error("terminal_not_found");
		return session;
	};
	const endListeners = (session: Session) => {
		for (const listener of session.listeners) listener.end();
		session.listeners.clear();
	};
	/** Starts a run; a request becomes Claude Code's initial prompt (an argument, never a shell). */
	function launch(session: Session, size: TerminalSize, prompt?: string) {
		if (!command) throw new Error("terminal_unavailable");
		const token = options.hookBaseUrl ? newHookToken() : undefined;
		const pty = spawn({
			command: [
				...command,
				...(token
					? [
							"--settings",
							hookSettings(options.hookBaseUrl!, session.id, token),
						]
					: []),
				// A leading space keeps a request that starts with "-" from being read as an option.
				...(prompt ? [prompt.startsWith("-") ? ` ${prompt}` : prompt] : []),
			],
			size: { cols: size.cols, rows: size.rows },
			onData(bytes) {
				if (session.pty !== pty) return;
				const copy = bytes.slice();
				session.backlog.push(copy);
				session.backlogSize += copy.byteLength;
				while (session.backlogSize > backlogBytes && session.backlog.length > 1)
					session.backlogSize -= session.backlog.shift()!.byteLength;
				for (const listener of session.listeners) listener.data(copy);
			},
		});
		// Cleared only once the new run exists, so a failed restart keeps the last output.
		session.backlog = [];
		session.backlogSize = 0;
		session.pty = pty;
		session.hookToken = token;
		session.size = { cols: size.cols, rows: size.rows };
		session.status = "running";
		session.activity = prompt ? "working" : "idle";
		delete session.task;
		session.run += 1;
		session.startedAt = now().toISOString();
		delete session.exitCode;
		delete session.endedAt;
		changed();
		void pty.exited.then((code) => {
			if (session.pty !== pty || sessions.get(session.id) !== session) return;
			pty.close();
			session.status = "exited";
			session.exitCode = code;
			session.endedAt = now().toISOString();
			delete session.task;
			changed();
			endListeners(session);
			log.info("terminals.exited", {
				sessionId: session.id,
				exitCode: code ?? -1,
			});
		});
	}

	function open(
		request: { title?: string; prompt?: string } & TerminalSize,
	): Session {
		if (!command) throw new Error("terminal_unavailable");
		if (sessions.size >= limit) throw new Error("terminal_limit_reached");
		opened += 1;
		const session = {
			id: crypto.randomUUID(),
			title: request.title ?? `Claude Code ${opened}`,
			run: 0,
			listeners: new Set<Listener>(),
		} as Session;
		launch(session, request, request.prompt);
		sessions.set(session.id, session);
		log.info("terminals.started", {
			sessionId: session.id,
			count: sessions.size,
		});
		return session;
	}
	function submit(session: Session, prompt: string) {
		const pty = session.pty;
		pty.write(`${PASTE_START}${prompt}${PASTE_END}`);
		const enter = setTimeout(() => {
			if (session.pty === pty && session.status === "running") pty.write("\r");
		}, options.submitDelayMs ?? 150);
		enter.unref?.();
	}

	/**
	 * Typed into the latest running session, or the initial prompt of a run (the latest ended
	 * session is restarted, otherwise a session is opened). `new` always opens another session.
	 */
	function handOver(input: { prompt: string; session?: "current" | "new" }): {
		session: TerminalSessionView;
		started: boolean;
	} {
		const latest = [...sessions.values()].reverse();
		if (input.session !== "new") {
			const running = latest.find((s) => s.status === "running");
			if (running) {
				submit(running, input.prompt);
				return { session: view(running), started: false };
			}
			const ended = latest[0];
			if (ended) {
				launch(ended, ended.size, input.prompt);
				return { session: view(ended), started: true };
			}
		}
		return {
			session: view(open({ ...DEFAULT_TERMINAL_SIZE, prompt: input.prompt })),
			started: true,
		};
	}

	return {
		available: () => command !== null,
		list(): TerminalSessionsView {
			return {
				available: command !== null,
				revision,
				limit,
				requests,
				sessions: [...sessions.values()].map(view),
			};
		},
		start(request: { title?: string } & TerminalSize): TerminalSessionView {
			return view(open(request));
		},
		restart(id: string, size: TerminalSize): TerminalSessionView {
			const session = find(id);
			if (session.status === "running") throw new Error("terminal_running");
			launch(session, size);
			return view(session);
		},
		/**
		 * Hands a request to Claude Code: typed into the latest running session, or the initial
		 * prompt of a run (the latest ended session is restarted, otherwise a session is opened).
		 * `new` always opens another session.
		 */
		request(input: {
			prompt: string;
			/** Short name of the task, chosen from the person's words. */
			task: string;
			session?: "current" | "new";
			/** The conversation that asked; its task is reported there when it finishes. */
			conversationId?: string;
		}): {
			session: TerminalSessionView;
			started: boolean;
		} {
			const handed = handOver(input);
			const session = sessions.get(handed.session.id)!;
			session.task = { name: input.task, conversationId: input.conversationId };
			session.activity = "working";
			requests += 1;
			changed();
			return { ...handed, session: view(session) };
		},
		input(id: string, data: string) {
			const session = find(id);
			if (session.status !== "running") throw new Error("terminal_not_running");
			session.pty.write(data);
		},
		resize(id: string, size: TerminalSize) {
			const session = find(id);
			if (session.status !== "running") return;
			session.size = { cols: size.cols, rows: size.rows };
			session.pty.resize(size);
		},
		/**
		 * The session's output as server-sent events (see `outputStream`), up to
		 * `streamsPerSession` watchers at once.
		 */
		stream(id: string, signal: AbortSignal): Response {
			const session = find(id);
			if (session.listeners.size >= streamsPerSession)
				throw new Error("terminal_stream_capacity");
			return outputStream(session, signal, options.heartbeatMs ?? 15_000);
		},
		/**
		 * One Claude Code hook of a session's current run, authenticated by that run's token. A
		 * Stop while a conversation task is open finishes the task and reports it to listeners.
		 */
		hook(id: string, token: string, payload: HookPayload) {
			const session = find(id);
			if (
				session.status !== "running" ||
				!session.hookToken ||
				!sameToken(token, session.hookToken)
			)
				throw new Error("terminal_hook_forbidden");
			const event = payload.hook_event_name;
			session.activity =
				event === "Stop"
					? "idle"
					: event === "Notification"
						? "waiting"
						: "working";
			const task = event === "Stop" ? session.task : undefined;
			if (task) delete session.task;
			changed();
			if (!task) return;
			const report: TaskFinished = {
				sessionId: session.id,
				run: session.run,
				task: task.name,
				...(task.conversationId ? { conversationId: task.conversationId } : {}),
				lastMessage: (payload.last_assistant_message ?? "").slice(
					0,
					LAST_MESSAGE_CHARS,
				),
			};
			log.info("terminals.task_finished", { sessionId: session.id });
			for (const listener of finished) listener(report);
		},
		/** Listens for finished conversation tasks; returns the unsubscribe. */
		onTaskFinished(listener: (event: TaskFinished) => void) {
			finished.add(listener);
			return () => {
				finished.delete(listener);
			};
		},
		/** Ends every running session (server shutdown). */
		closeAll() {
			for (const session of sessions.values()) {
				if (session.status === "running") session.pty.kill();
				else session.pty.close();
				endListeners(session);
			}
			sessions.clear();
		},
	};
}
export type TerminalsService = ReturnType<typeof createTerminals>;
