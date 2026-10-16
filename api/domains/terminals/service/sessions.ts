import { getLogger } from "../../../infrastructure/logger";
import type {
	TerminalSessionView,
	SessionMode,
	SessionOwner,
} from "../contracts";
import { newHookToken, removeHookSettings, writeHookSettings } from "./hooks";
import type { Ledger } from "./ledger";
import { bunSpawnPty } from "./spawn";
import { type Listener, outputStream } from "./stream";
import type { Inflight, Pty, Runtime, Session, TerminalSize } from "./types";

const log = getLogger("terminals");

/** Size of a session started without a screen (from the conversation) until a pane fits it. */
export const DEFAULT_TERMINAL_SIZE: TerminalSize = { cols: 120, rows: 32 };
/** Exited sessions kept in the list so their last output can be read. */
const KEPT_EXITED = 8;
/** Bracketed paste keeps a multi-line request one input instead of a line per Enter. */
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** How a run is started: a new conversation or a resumed one, with an optional first request. */
type Launch = {
	size: TerminalSize;
	claude: { resume: boolean; id: string };
	prompt?: string;
	inflight?: Inflight;
};

export function sessionView(s: Session): TerminalSessionView {
	const live = s.status === "running";
	return {
		id: s.id,
		title: s.title,
		owner: s.owner,
		mode: s.mode,
		status: s.status,
		run: s.run,
		...(live ? { activity: s.activity } : {}),
		...(live && s.inflight ? { task: s.inflight.task } : {}),
		...(s.exitCode !== undefined ? { exitCode: s.exitCode } : {}),
		startedAt: s.startedAt,
		...(s.endedAt ? { endedAt: s.endedAt } : {}),
	};
}

/** A turn the person started (no request of ours) counts as running for this long after its last hook. */
const MANUAL_TURN_MS = 30 * 60 * 1000;
/**
 * `working` / `waiting` with no request on the PTY and no hook for `MANUAL_TURN_MS`: the turn was
 * most likely interrupted (Esc sends no hook), so it no longer holds back the Kanban queue.
 */
export const activityStale = (s: Session, nowMs: number) =>
	(s.activity === "working" || s.activity === "waiting") &&
	!s.inflight &&
	nowMs - s.lastHookAtMs >= MANUAL_TURN_MS;

/**
 * Another live PTY holds the Kanban session's Claude conversation: a second process on it would
 * write into the same history.
 */
const conversationBusy = (list: Session[], session: Session) =>
	session.owner.startsWith("kanban:") &&
	list.some(
		(s) =>
			s !== session &&
			s.status === "running" &&
			s.claudeSessionId === session.claudeSessionId,
	);

export function createEntry(init: {
	id?: string;
	title: string;
	owner: SessionOwner;
	mode: SessionMode;
	cwd: string | undefined;
}): Session {
	return {
		id: init.id ?? crypto.randomUUID(),
		pendingManualInputs: 0,
		manualInputSeen: false,
		title: init.title,
		owner: init.owner,
		mode: init.mode,
		cwd: init.cwd,
		run: 0,
		lastInputAtMs: 0,
		lastHookAtMs: 0,
		listeners: new Set<Listener>(),
	} as unknown as Session;
}

function openDirect(
	rt: Runtime,
	request: { title?: string } & TerminalSize,
	id: string | undefined,
	ops: {
		liveCount: () => number;
		nextTitle: () => string;
		launch: (session: Session, spec: Launch) => void;
		prune: () => void;
	},
): Session {
	if (!rt.command) throw new Error("terminal_unavailable");
	if (ops.liveCount() >= rt.limit) throw new Error("terminal_limit_reached");
	const session = createEntry({
		id,
		title: request.title ?? ops.nextTitle(),
		owner: "direct",
		mode: "work",
		cwd: rt.options.cwd,
	});
	ops.launch(session, {
		size: request,
		claude: { resume: false, id: crypto.randomUUID() },
	});
	rt.sessions.set(session.id, session);
	ops.prune();
	log.info("terminals.started", {
		sessionId: session.id,
		count: ops.liveCount(),
	});
	return session;
}
/** Terminates a run: SIGTERM, SIGKILL after a while; true when the exit was seen in time. */
async function terminate(
	session: Session,
	killAfterMs: number,
	stopConfirmMs: number,
): Promise<boolean> {
	session.stopping = true;
	const pty = session.pty;
	pty.kill("SIGTERM");
	const kill = setTimeout(() => {
		if (session.pty === pty && session.status === "running")
			pty.kill("SIGKILL");
	}, killAfterMs);
	let give!: ReturnType<typeof setTimeout>;
	const timeout = new Promise<boolean>((resolve) => {
		give = setTimeout(() => resolve(false), stopConfirmMs);
	});
	const confirmed = await Promise.race([
		session.exit.then(() => true),
		timeout,
	]);
	clearTimeout(kill);
	clearTimeout(give);
	// A late exit is an ordinary end of the run.
	if (!confirmed) session.stopping = false;
	return confirmed;
}

/**
 * The PTY side: sessions, their processes and screens. Which request goes where is the
 * sender's decision (`dispatcher.ts`); what a hook means is `hook-events.ts`.
 */
export function createSessions(
	rt: Runtime,
	ledger: Ledger,
	trackingLost: (session: Session) => void,
) {
	const { options } = rt;
	const spawn = options.spawn ?? bunSpawnPty(options.cwd);
	const backlogBytes = options.backlogBytes ?? 512 * 1024;
	const submitDelayMs = options.submitDelayMs ?? 150;
	const trackingMs = options.trackingMs ?? 10_000;
	const killAfterMs = options.killAfterMs ?? 5_000;
	const stopConfirmMs = options.stopConfirmMs ?? 10_000;
	let opened = 0;

	const nextTitle = () => `Claude Code ${++opened}`;
	const find = (id: string) => {
		const session = rt.sessions.get(id);
		if (!session) throw new Error("terminal_not_found");
		return session;
	};
	const all = () => [...rt.sessions.values()];
	const isLive = (s: Session) => s.status === "running";
	const liveCount = () => all().filter(isLive).length;
	const endListeners = (session: Session) => {
		for (const listener of session.listeners) listener.end();
		session.listeners.clear();
	};

	/** Drops the oldest exited sessions beyond the ones kept for reading. */
	function prune() {
		const exited = all()
			.filter((s) => s.status === "exited")
			.sort((a, b) => (a.endedAt ?? "").localeCompare(b.endedAt ?? ""));
		for (const old of exited.slice(
			0,
			Math.max(0, exited.length - KEPT_EXITED),
		)) {
			removeHookSettings(old.settingsPath);
			endListeners(old);
			rt.sessions.delete(old.id);
		}
	}

	async function onExit(
		session: Session,
		pty: Pty,
		settingsPath: string | undefined,
		code: number | null,
	) {
		if (session.pty !== pty || rt.sessions.get(session.id) !== session) return;
		// Releasing resources must never keep the session "running": a failure is logged and the exit is still recorded.
		try {
			pty.close();
			removeHookSettings(settingsPath);
		} catch {
			log.warn("terminals.release_failed", { sessionId: session.id });
		}
		clearTimeout(session.trackingTimer);
		clearTimeout(session.wakeTimer);
		session.status = "exited";
		session.exitCode = code;
		session.endedAt = rt.nowIso();
		session.closing = false;
		endListeners(session);
		session.exitDone();
		log.info("terminals.exited", {
			sessionId: session.id,
			exitCode: code ?? -1,
		});
		const flight = session.inflight;
		// While `sending` the sender owns the request; `stop` owns it while it waits for this exit.
		if (flight && flight.phase !== "sending" && !session.stopping) {
			const resumeFailed = session.resumed && !session.sessionStarted;
			try {
				await ledger.finalize(
					flight.id,
					{
						state: "ended",
						reason: resumeFailed ? "resume_failed" : "session_ended",
					},
					session,
				);
			} catch {
				log.warn("terminals.finish_save_failed", { attemptId: flight.id });
			}
		}
		prune();
		rt.changed();
		rt.kick();
	}

	/** Starts a run in `session` (a new entry or an exited one); throws when it cannot start. */
	function launch(session: Session, spec: Launch) {
		options.workspace?.assertLaunch({
			sessionId: session.id,
			owner: session.owner,
			cwd: session.cwd,
			run: session.run + 1,
		});
		if (!rt.command) throw new Error("terminal_unavailable");
		const token = rt.baseUrl ? newHookToken() : undefined;
		const denyGitWrites =
			session.owner.startsWith("kanban:") && session.mode === "work";
		const settingsPath = token
			? writeHookSettings(rt.baseUrl!, session.id, token, denyGitWrites)
			: undefined;
		let pty: Pty;
		try {
			pty = spawn({
				command: [
					...rt.command,
					spec.claude.resume ? "--resume" : "--session-id",
					spec.claude.id,
					...(settingsPath ? ["--settings", settingsPath] : []),
					// A leading space keeps a request that starts with "-" from being read as an option.
					...(spec.prompt
						? [spec.prompt.startsWith("-") ? ` ${spec.prompt}` : spec.prompt]
						: []),
				],
				size: { cols: spec.size.cols, rows: spec.size.rows },
				cwd: session.cwd,
				onData(bytes) {
					if (session.pty !== pty) return;
					const copy = bytes.slice();
					session.backlog.push(copy);
					session.backlogSize += copy.byteLength;
					while (
						session.backlogSize > backlogBytes &&
						session.backlog.length > 1
					)
						session.backlogSize -= session.backlog.shift()!.byteLength;
					for (const listener of session.listeners) listener.data(copy);
				},
			});
		} catch (error) {
			removeHookSettings(settingsPath);
			throw error;
		}
		// Cleared only once the new run exists, so a failed restart keeps the last output.
		session.backlog = [];
		session.backlogSize = 0;
		removeHookSettings(session.settingsPath);
		session.settingsPath = settingsPath;
		session.pty = pty;
		session.hookToken = token;
		session.size = { cols: spec.size.cols, rows: spec.size.rows };
		session.status = "running";
		session.activity = spec.prompt ? "working" : "idle";
		session.claudeSessionId = spec.claude.id;
		session.hookSessionId = spec.claude.id;
		session.resumed = spec.claude.resume;
		session.sessionStarted = false;
		session.promptChecked = false;
		session.closing = false;
		session.stopping = false;
		session.inflight = spec.inflight;
		session.run += 1;
		session.startedAt = rt.nowIso();
		session.startedAtMs = rt.now();
		session.lastUsedAtMs = session.startedAtMs;
		session.lastHookAtMs = session.startedAtMs;
		delete session.exitCode;
		delete session.endedAt;
		session.exit = new Promise<void>((resolve) => {
			session.exitDone = resolve;
		});
		clearTimeout(session.trackingTimer);
		// A run that carries a request must show within a moment that its hooks arrive.
		if (token && spec.inflight) {
			const run = session.run;
			session.trackingTimer = setTimeout(() => {
				if (session.run === run && isLive(session) && !session.sessionStarted)
					trackingLost(session);
			}, trackingMs);
			session.trackingTimer.unref?.();
		}
		rt.changed();
		void pty.exited
			.then((code) => onExit(session, pty, settingsPath, code))
			.catch(() => {
				// No unhandled rejection; waiting stops (`stop`) must not hang on a failed handler.
				log.warn("terminals.exit_handler_failed", { sessionId: session.id });
				session.exitDone();
			});
	}

	return {
		find,
		all,
		isLive,
		liveCount,
		launch,
		nextTitle,
		terminate: (session: Session) =>
			terminate(session, killAfterMs, stopConfirmMs),
		trackingMs,

		/** Opens a session for the screen (no request): a fresh conversation, nothing sent. */
		open: (request: { title?: string } & TerminalSize, id?: string) =>
			openDirect(rt, request, id, { liveCount, nextTitle, launch, prune }),

		/** Restarts an exited session; a Kanban card's conversation is resumed, not replaced. */
		restart(id: string, size: TerminalSize): Session {
			const session = find(id);
			if (isLive(session)) throw new Error("terminal_running");
			if (liveCount() >= rt.limit) throw new Error("terminal_limit_reached");
			if (conversationBusy(all(), session))
				throw new Error("terminal_conversation_busy");
			launch(session, {
				size,
				claude: session.owner.startsWith("kanban:")
					? { resume: true, id: session.claudeSessionId }
					: { resume: false, id: crypto.randomUUID() },
			});
			return session;
		},

		/** Types a request into a running session and presses Enter once the paste landed. */
		paste(session: Session, prompt: string) {
			const pty = session.pty;
			// A raw ESC could end the bracketed paste early; requests are refused at enqueue, this is the last guard.
			pty.write(`${PASTE_START}${prompt.replaceAll("\x1b", "")}${PASTE_END}`);
			const enter = setTimeout(() => {
				if (session.pty === pty && isLive(session)) pty.write("\r");
			}, submitDelayMs);
			enter.unref?.();
		},

		input(id: string, data: string) {
			const session = find(id);
			if (!isLive(session)) throw new Error("terminal_not_running");
			if (session.closing) throw new Error("terminal_workspace_releasing");
			session.manualInputSeen = true;
			session.lastInputAtMs = rt.now();
			session.lastUsedAtMs = session.lastInputAtMs;
			session.pty.write(data);
			// A request waiting for the quiet time after typing is looked at again then.
			// One pending wake-up per PTY, however many keystrokes arrive.
			clearTimeout(session.wakeTimer);
			session.wakeTimer = setTimeout(
				rt.kick,
				(options.manualInputWaitMs ?? 3000) + 20,
			);
			session.wakeTimer.unref?.();
		},

		resize(id: string, size: TerminalSize) {
			const session = find(id);
			if (!isLive(session)) return;
			session.size = { cols: size.cols, rows: size.rows };
			session.pty.resize(size);
		},

		stream(id: string, signal: AbortSignal): Response {
			const session = find(id);
			if (session.listeners.size >= (options.streamsPerSession ?? 4))
				throw new Error("terminal_stream_capacity");
			return outputStream(session, signal, options.heartbeatMs ?? 15_000);
		},

		/** Ends a run on the host's own initiative (evicted, replaced by another mode). */
		close(session: Session) {
			session.closing = true;
			session.pty.kill();
		},

		/**
		 * The idle Kanban session unused for the longest time, which can be closed to make room
		 * (its conversation stays on disk). Sessions of the conversation are never closed.
		 */
		evictable(): Session | undefined {
			return all()
				.filter(
					(s) =>
						isLive(s) &&
						!s.closing &&
						s.owner.startsWith("kanban:") &&
						s.activity === "idle" &&
						!s.inflight &&
						(!rt.options.workspace ||
							(!s.manualInputSeen && s.pendingManualInputs === 0)),
				)
				.sort((a, b) => a.lastUsedAtMs - b.lastUsedAtMs)[0];
		},

		closeAll() {
			for (const session of rt.sessions.values()) {
				clearTimeout(session.trackingTimer);
				clearTimeout(session.wakeTimer);
				if (isLive(session)) session.pty.kill();
				else session.pty.close();
				removeHookSettings(session.settingsPath);
				endListeners(session);
			}
			rt.sessions.clear();
		},
	};
}
export type Sessions = ReturnType<typeof createSessions>;
