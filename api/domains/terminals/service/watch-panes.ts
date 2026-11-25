import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type {
	TerminalActivity,
	TerminalSessionsView,
	TerminalSessionView,
	TerminalStatus,
} from "../contracts";
import type { TerminalSize } from "./types";

/**
 * Read-only panes shown beside the sessions: the works the conversation handed to Claude Code,
 * supplied by the application (the owner of those works is another domain).
 */
export type TerminalWatchPort = {
	listInTransaction(db: Database): Array<{
		id: string;
		title: string;
		status: TerminalStatus;
		activity: TerminalActivity;
		startedAt: string;
		endedAt?: string;
		statusMessage?: string;
	}>;
	/** Grows by one with every work handed over. */
	requestsInTransaction(db: Database): number;
	hasInTransaction(db: Database, id: string): boolean;
	stream(id: string, signal: AbortSignal): Promise<Response | null>;
	subscribe(listener: () => void): () => void;
};

/**
 * The screen's list and output for the read-only panes. `list()` of the sessions stays the
 * sessions alone, since the workspace guard and the conversation's snapshot read it.
 */
export function createWatchPanes(input: {
	store?: SqliteStore;
	list(): TerminalSessionsView;
	changed(): void;
	resize(id: string, size: TerminalSize): void;
}) {
	let watch: TerminalWatchPort | undefined;
	let unwatch: (() => void) | undefined;

	function screensInTransaction(db: Database): TerminalSessionsView {
		const own = input.list();
		if (!watch) return own;
		return {
			...own,
			requests: own.requests + watch.requestsInTransaction(db),
			sessions: [
				...own.sessions,
				...watch.listInTransaction(db).map((pane): TerminalSessionView => ({
					id: pane.id,
					title: pane.title,
					owner: `claude-task:${pane.id}`,
					mode: "work",
					status: pane.status,
					run: 1,
					activity: pane.activity,
					startedAt: pane.startedAt,
					...(pane.endedAt ? { endedAt: pane.endedAt } : {}),
					...(pane.statusMessage ? { statusMessage: pane.statusMessage } : {}),
					readOnly: true,
				})),
			],
		};
	}
	/** The read-only pane of this id, when the id is one (a session id never is). */
	const watched = (id: string) =>
		!!watch &&
		!!input.store &&
		input.store.read((db) => watch!.hasInTransaction(db, id));

	return {
		/** Connects the read-only panes; their changes advance the revision like a session's. */
		configureWatch(port: TerminalWatchPort) {
			unwatch?.();
			watch = port;
			unwatch = port.subscribe(input.changed);
		},
		/** What the screen shows: the sessions, then the read-only panes. */
		screensInTransaction,
		screens(): TerminalSessionsView {
			const store = input.store;
			return store && watch ? store.read(screensInTransaction) : input.list();
		},
		/** A read-only pane has no size of its own to send anywhere. */
		resize(id: string, size: TerminalSize) {
			if (watched(id)) return;
			return input.resize(id, size);
		},
		/** The output of a read-only pane; null when the id is a session's (use `stream`). */
		watchStream(id: string, signal: AbortSignal): Promise<Response> | null {
			if (!watched(id)) return null;
			return watch!.stream(id, signal).then((response) => {
				if (!response) throw new Error("terminal_not_found");
				return response;
			});
		},
		close() {
			unwatch?.();
		},
	};
}
