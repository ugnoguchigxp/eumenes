import { getLogger } from "../../infrastructure/logger";
import type {
	TerminalSessionView,
	TerminalSessionsView,
	TerminalStatus,
} from "./contracts";

export type TerminalSize = { cols: number; rows: number };

/** A spawned PTY process. Its output arrives through `onData` given at spawn. */
export type Pty = {
	write(data: string): void;
	resize(size: TerminalSize): void;
	kill(): void;
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
	now?: () => Date;
};

type Listener = { data(bytes: Uint8Array): void; end(): void };
type Session = {
	id: string;
	title: string;
	status: TerminalStatus;
	run: number;
	exitCode?: number | null;
	startedAt: string;
	endedAt?: string;
	pty: Pty;
	backlog: Uint8Array[];
	backlogSize: number;
	listeners: Set<Listener>;
};

const log = getLogger("terminals");

/** Spawns through Bun's PTY support (POSIX only). The child sees a real xterm-256color terminal. */
export function bunSpawnPty(
	cwd: string | undefined,
	env: Record<string, string | undefined> = process.env,
): SpawnPty {
	return ({ command, size, onData }) => {
		const proc = Bun.spawn([...command], {
			cwd,
			env: { ...env, TERM: "xterm-256color", COLORTERM: "truecolor" },
			terminal: {
				...size,
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

const encoder = new TextEncoder();
const frame = (event: string, data: string) =>
	encoder.encode(`event: ${event}\ndata: ${data}\n\n`);

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

	const view = (s: Session): TerminalSessionView => ({
		id: s.id,
		title: s.title,
		status: s.status,
		run: s.run,
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
	function launch(session: Session, size: TerminalSize) {
		if (!command) throw new Error("terminal_unavailable");
		session.backlog = [];
		session.backlogSize = 0;
		const pty = spawn({
			command,
			size,
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
		session.pty = pty;
		session.status = "running";
		session.run += 1;
		session.startedAt = now().toISOString();
		delete session.exitCode;
		delete session.endedAt;
		revision += 1;
		void pty.exited.then((code) => {
			if (session.pty !== pty || sessions.get(session.id) !== session) return;
			session.status = "exited";
			session.exitCode = code;
			session.endedAt = now().toISOString();
			revision += 1;
			endListeners(session);
			log.info("terminals.exited", {
				sessionId: session.id,
				exitCode: code ?? -1,
			});
		});
	}

	return {
		available: () => command !== null,
		list(): TerminalSessionsView {
			return {
				available: command !== null,
				revision,
				limit,
				sessions: [...sessions.values()].map(view),
			};
		},
		start(request: { title?: string } & TerminalSize): TerminalSessionView {
			if (!command) throw new Error("terminal_unavailable");
			if (sessions.size >= limit) throw new Error("terminal_limit_reached");
			opened += 1;
			const session = {
				id: crypto.randomUUID(),
				title: request.title ?? `Claude Code ${opened}`,
				run: 0,
				listeners: new Set<Listener>(),
			} as Session;
			launch(session, request);
			sessions.set(session.id, session);
			log.info("terminals.started", {
				sessionId: session.id,
				count: sessions.size,
			});
			return view(session);
		},
		restart(id: string, size: TerminalSize): TerminalSessionView {
			const session = find(id);
			if (session.status === "running") throw new Error("terminal_running");
			launch(session, size);
			return view(session);
		},
		input(id: string, data: string) {
			const session = find(id);
			if (session.status !== "running") throw new Error("terminal_not_running");
			session.pty.write(data);
		},
		resize(id: string, size: TerminalSize) {
			const session = find(id);
			if (session.status === "running") session.pty.resize(size);
		},
		remove(id: string) {
			const session = find(id);
			sessions.delete(id);
			if (session.status === "running") session.pty.kill();
			endListeners(session);
			revision += 1;
		},
		/**
		 * Server-sent events: `output` frames carry base64 PTY bytes (the backlog first), `exit`
		 * ends a run. A client that cannot keep up is disconnected rather than buffered.
		 */
		stream(id: string, signal: AbortSignal): Response {
			const session = find(id);
			if (session.listeners.size >= streamsPerSession)
				throw new Error("terminal_stream_capacity");
			let cleanup = () => {};
			const body = new ReadableStream<Uint8Array>(
				{
					start(controller) {
						let ended = false;
						// Ending without an `exit` frame tells the client to read the session again.
						const drop = () => {
							if (ended) return;
							cleanup();
							controller.close();
						};
						const send = (chunk: Uint8Array) => {
							if (ended) return;
							if ((controller.desiredSize ?? 0) <= 0) drop();
							else controller.enqueue(chunk);
						};
						const listener: Listener = {
							data: (bytes) =>
								send(frame("output", Buffer.from(bytes).toString("base64"))),
							end() {
								if (ended) return;
								controller.enqueue(frame("exit", "{}"));
								drop();
							},
						};
						const heartbeat = setInterval(
							() => send(encoder.encode(": heartbeat\n\n")),
							options.heartbeatMs ?? 15_000,
						);
						heartbeat.unref?.();
						cleanup = () => {
							ended = true;
							clearInterval(heartbeat);
							session.listeners.delete(listener);
							signal.removeEventListener("abort", drop);
						};
						signal.addEventListener("abort", drop, { once: true });
						if (session.backlog.length)
							listener.data(Buffer.concat(session.backlog));
						if (signal.aborted) drop();
						else if (session.status !== "running") listener.end();
						else session.listeners.add(listener);
					},
					cancel() {
						cleanup();
					},
				},
				{ highWaterMark: 64 },
			);
			return new Response(body, {
				headers: {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-store",
					"X-Accel-Buffering": "no",
				},
			});
		},
		/** Ends every running session (server shutdown). */
		closeAll() {
			for (const session of sessions.values()) {
				if (session.status === "running") session.pty.kill();
				endListeners(session);
			}
			sessions.clear();
		},
	};
}
export type TerminalsService = ReturnType<typeof createTerminals>;
