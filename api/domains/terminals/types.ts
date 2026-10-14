import type { SqliteStore } from "../../infrastructure/sqlite";
import type {
	ProjectResolver,
	RequestReason,
	SessionMode,
	SessionOwner,
	TerminalActivity,
	TerminalRequestFinished,
	TerminalStatus,
} from "./contracts";
import type { Listener } from "./stream";

export type TerminalSize = { cols: number; rows: number };

/** A spawned PTY process. Its output arrives through `onData` given at spawn. */
export type Pty = {
	write(data: string): void;
	resize(size: TerminalSize): void;
	/**
	 * Without a signal: ends the process and closes the terminal. With one: only sends the
	 * signal (the exit is awaited through `exited`).
	 */
	kill(signal?: "SIGTERM" | "SIGKILL"): void;
	/** Releases the PTY after the process exited. */
	close(): void;
	/** Resolves with the process exit code (null when it was signalled). */
	exited: Promise<number | null>;
};
export type SpawnPty = (request: {
	command: readonly string[];
	size: TerminalSize;
	/** Working directory of the project; the default of the spawner when absent. */
	cwd?: string;
	onData(bytes: Uint8Array): void;
}) => Pty;

export type TerminalsOptions = {
	/** The fixed program; null when it is not installed. Defaults to `claude` on PATH. */
	command?: readonly string[] | null;
	/** Working directory of the default project `eumenes` and of screen-started sessions. */
	cwd?: string;
	/** Requests are saved here (migration `terminals/0001-requests`); without it none can be queued. */
	store?: SqliteStore;
	/** Registered projects; defaults to `eumenes` = `cwd`. */
	projects?: ProjectResolver;
	spawn?: SpawnPty;
	/** Live Claude Code processes at once (exited sessions do not count). */
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
	 * Claude Code hooks that report its progress here; without it, requests cannot be tracked.
	 */
	hookBaseUrl?: string;
	/** `curl` is what the hooks run; null when it is not installed. Defaults to PATH lookup. */
	curl?: string | null;
	/** A session, its activity or a request changed (the host publishes a change event). */
	onChange?: () => void;
	now?: () => Date;
	/** Review of queued requests when nothing woke the sender (default 5 s). */
	sweepMs?: number;
	/** A launched run must report SessionStart within this time (default 10 s). */
	trackingMs?: number;
	/** Quiet time after the person typed in a session before a request is pasted (default 3 s). */
	manualInputWaitMs?: number;
	/** `stop`: SIGKILL after this long (default 5 s) ... */
	killAfterMs?: number;
	/** ... and the exit must be seen within this long (default 10 s). */
	stopConfirmMs?: number;
};

/** The request a session is carrying: sent (or being sent) and not yet final. */
export type Inflight = {
	id: string;
	phase: "sending" | "delivered" | "started";
	/** Text that was sent; the turn Claude Code starts must show it. */
	prompt: string;
	task: string;
	owner: SessionOwner;
	exclusiveGroup?: "kanban";
	promptId?: string;
	files: string[];
	waitNotified: boolean;
};

export type Session = {
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
	owner: SessionOwner;
	mode: SessionMode;
	/** The Claude conversation this run was launched with (`--session-id` / `--resume`). */
	claudeSessionId: string;
	/**
	 * The conversation the run's hooks currently report: `claudeSessionId` until the person
	 * clears it (`/clear` starts a new one). Used for activity tracking only.
	 */
	hookSessionId: string;
	/** The last accepted hook of this run (ms); a turn the person started is trusted for 30 min. */
	lastHookAtMs: number;
	/** Pending wake-up of the sender after the person typed (one per PTY). */
	wakeTimer?: ReturnType<typeof setTimeout>;
	cwd: string | undefined;
	/** Launched with `--resume`: ending without SessionStart means the conversation is gone. */
	resumed: boolean;
	/** SessionStart seen: Claude Code reports through the hooks. */
	sessionStarted: boolean;
	/** The first prompt of the run was checked for a prompt_id. */
	promptChecked: boolean;
	startedAtMs: number;
	lastInputAtMs: number;
	lastUsedAtMs: number;
	inflight?: Inflight;
	/** Being ended by the host (evicted, replaced by another mode, stopped); still counts as live. */
	closing: boolean;
	/** `stop` is waiting for the exit and owns the final state of the request. */
	stopping: boolean;
	trackingTimer?: ReturnType<typeof setTimeout>;
	hookToken?: string;
	settingsPath?: string;
	/** Settles when the run's exit has been handled. */
	exit: Promise<void>;
	exitDone: () => void;
	backlog: Uint8Array[];
	backlogSize: number;
	listeners: Set<Listener>;
};

/** How a request ended. */
export type Outcome = {
	state: TerminalRequestFinished["state"];
	reason?: RequestReason;
	report?: string;
};

/** Shared state and operations the parts of the service reach each other through. */
export type Runtime = {
	options: TerminalsOptions;
	sessions: Map<string, Session>;
	command: readonly string[] | null;
	/** Validated loopback URL of the hooks; undefined when hooks are off. */
	baseUrl: string | undefined;
	projects: ProjectResolver;
	limit: number;
	/** Requests of the conversation sent so far (a screen opens when it grows). */
	sent: number;
	now(): number;
	nowIso(): string;
	changed(): void;
	/** Wakes the sender. */
	kick(): void;
	trackable(): boolean;
};
