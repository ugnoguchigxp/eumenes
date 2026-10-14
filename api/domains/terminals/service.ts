import { getLogger } from "../../infrastructure/logger";
import type { Database } from "bun:sqlite";
import type {
	EnqueueRequest,
	SessionMode,
	SessionOwner,
	TerminalActivity,
	TerminalRequestView,
	TerminalSessionsView,
	TerminalSessionView,
	TerminalStatus,
} from "./contracts";
import { createDispatcher } from "./dispatcher";
import { createHookEvents } from "./hook-events";
import { type HookPayload, hookBaseUrl, sameToken } from "./hooks";
import { createLedger } from "./ledger";
import * as repository from "./repository";
import { toView } from "./requests";
import { createSessions, sessionView } from "./sessions";
import type { Runtime, Session, TerminalSize, TerminalsOptions } from "./types";

const log = getLogger("terminals");

function defaultCommand(): readonly string[] | null {
	const path = Bun.which("claude");
	return path ? [path] : null;
}

/**
 * Claude Code sessions (PTYs) of this process and the queue of requests for them. Sessions end
 * with the server; requests are saved in SQLite and sent by the dispatcher only after they
 * committed. Terminal input and output never reach the log.
 */
export function createTerminals(options: TerminalsOptions = {}) {
	const command =
		options.command === undefined ? defaultCommand() : options.command;
	const clock = options.now ?? (() => new Date());
	const baseUrl = hookBaseUrl(options.hookBaseUrl);
	if (options.hookBaseUrl && !baseUrl)
		log.warn("terminals.hooks_disabled", { reason: "hook_url_invalid" });
	const curl = options.curl === undefined ? Bun.which("curl") : options.curl;
	let revision = 0;
	const rt: Runtime = {
		options,
		sessions: new Map<string, Session>(),
		command,
		baseUrl,
		projects:
			options.projects ??
			((projectId) =>
				projectId === "eumenes" ? { cwd: options.cwd ?? process.cwd() } : null),
		limit: options.limit ?? 4,
		sent: 0,
		now: () => clock().getTime(),
		nowIso: () => clock().toISOString(),
		changed() {
			revision += 1;
			options.onChange?.();
		},
		kick: () => dispatcher.kick(),
		/** Requests can be tracked: hooks reach this server, `curl` exists, and they are saved. */
		trackable: () =>
			command !== null &&
			baseUrl !== undefined &&
			curl !== null &&
			options.store !== undefined,
	};
	const ledger = createLedger(rt);
	const trackingLost = (session: Session) => {
		session.stopping = true;
		void (async () => {
			log.warn("terminals.tracking_lost", { sessionId: session.id });
			const flight = session.inflight;
			if (flight)
				try {
					await ledger.finalize(
						flight.id,
						{ state: "unknown", reason: "tracking_lost" },
						session,
					);
				} catch {
					log.warn("terminals.finish_save_failed", { attemptId: flight.id });
				}
			session.closing = true;
			await sessions.terminate(session);
		})();
	};
	const sessions = createSessions(rt, ledger, trackingLost);
	const dispatcher = createDispatcher(rt, ledger, sessions);
	const applyHook = createHookEvents(rt, ledger, trackingLost);

	const unsubscribe = options.store?.onCommit(() => {
		ledger.flushCommitted();
		dispatcher.kick();
	});
	const sweep = options.store
		? setInterval(() => {
				void ledger.retryUnsaved();
				dispatcher.kick();
			}, options.sweepMs ?? 5000)
		: undefined;
	sweep?.unref?.();

	function verifyHook(id: string, token: string) {
		const session = sessions.find(id);
		if (
			!sessions.isLive(session) ||
			!session.hookToken ||
			!sameToken(token, session.hookToken)
		)
			throw new Error("terminal_hook_forbidden");
		return session;
	}
	const openRequest = (db: Database, id: string) => {
		const row = ledger.request(db, id);
		if (!row) return null;
		const flight = sessions.all().find((s) => s.inflight?.id === id)?.inflight;
		return toView(row, flight?.files ?? row.files);
	};

	return {
		available: () => command !== null,
		/** Requests can be tracked and saved on this host. */
		trackable: rt.trackable,
		list(): TerminalSessionsView {
			return {
				available: command !== null,
				revision,
				limit: rt.limit,
				requests: rt.sent,
				sessions: sessions.all().map(sessionView),
			};
		},
		start: (request: { title?: string } & TerminalSize): TerminalSessionView =>
			sessionView(sessions.open(request)),
		restart: (id: string, size: TerminalSize): TerminalSessionView =>
			sessionView(sessions.restart(id, size)),
		input: sessions.input,
		resize: sessions.resize,
		/**
		 * The session's output as server-sent events (see `outputStream`), up to
		 * `streamsPerSession` watchers at once.
		 */
		stream: sessions.stream,
		/** Checks a hook's token for the session's current run before its body is read. */
		verifyHook: (id: string, token: string) => void verifyHook(id, token),
		/**
		 * One Claude Code hook of a session's current run, authenticated by that run's token.
		 * Throws when a final state could not be saved (the host answers 503).
		 */
		async hook(id: string, token: string, payload: HookPayload) {
			await applyHook(verifyHook(id, token), payload);
		},

		/** Saves a request inside the caller's writer transaction; nothing is sent before commit. */
		enqueueInTransaction: (tx: Database, request: EnqueueRequest) =>
			ledger.enqueue(tx, request),
		/** Cancels a request that was not sent yet; false when it already was (or is unknown). */
		cancelQueuedInTransaction: (tx: Database, attemptId: string) =>
			ledger.cancelQueued(tx, attemptId),
		requestInTransaction: (
			tx: Database,
			attemptId: string,
		): TerminalRequestView | null => openRequest(tx, attemptId),
		/**
		 * Ends the PTY of a request that was sent: SIGTERM, SIGKILL after 5 s, and once the exit
		 * is seen within 10 s the request becomes `unknown (stopped_by_person)`. When the exit
		 * cannot be confirmed nothing is written.
		 */
		async stop(attemptId: string): Promise<"stopped" | "unconfirmed"> {
			const store = options.store;
			if (!store) throw new Error("terminal_tracking_unavailable");
			const row = store.read((db) => repository.get(db, attemptId));
			if (!row) throw new Error("terminal_not_found");
			const session = sessions
				.all()
				.find((s) => s.inflight?.id === attemptId && sessions.isLive(s));
			if (!session) {
				if (row.state === "queued") throw new Error("terminal_not_running");
				return "stopped";
			}
			if (!(await sessions.terminate(session))) return "unconfirmed";
			await ledger.finalize(
				attemptId,
				{ state: "unknown", reason: "stopped_by_person" },
				session,
			);
			return "stopped";
		},
		onFinishedInTransaction: ledger.onFinished,
		/**
		 * Final states after their transaction committed (the in-transaction listeners run before
		 * that and may still be rolled back); for notices that must not be sent early.
		 */
		onFinishedCommitted: ledger.onFinishedCommitted,
		onWaitingInTransaction: ledger.onWaiting,
		/** Sessions as the board shows them. */
		activities(): Array<{
			terminalSessionId: string;
			owner: SessionOwner;
			mode: SessionMode;
			claudeSessionId?: string;
			status: TerminalStatus;
			activity: TerminalActivity;
		}> {
			return sessions.all().map((s) => ({
				terminalSessionId: s.id,
				owner: s.owner,
				mode: s.mode,
				claudeSessionId: s.claudeSessionId,
				status: s.status,
				activity: s.status === "running" ? s.activity : "idle",
			}));
		},
		/** Startup: unsent requests are cancelled and sent ones become unknown (never resent). */
		recover: () => ledger.recover(),
		/** Resolves once the sender has nothing more to do right now. */
		settled: () => dispatcher.settled(),
		/** Ends every running session (server shutdown). */
		closeAll() {
			clearInterval(sweep);
			unsubscribe?.();
			sessions.closeAll();
		},
	};
}
export type TerminalsService = ReturnType<typeof createTerminals>;
