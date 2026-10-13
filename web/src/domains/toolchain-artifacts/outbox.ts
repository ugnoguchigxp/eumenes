import {
	toolchainActionEventV1,
	type ToolchainActionEventV1,
} from "../../../../api/domains/tool-runtime/contracts";

/**
 * Pending write actions of this tab (spec §6.4). An entry exists from before the request is sent
 * until the server's answer is known, so a reload can reconcile the same eventId and input and
 * never turns an unknown outcome into a new operation. Only the secret-free action event is kept.
 */
export type OutboxStatus = "sending" | "pending" | "indeterminate" | "retry";
export type OutboxEntry = {
	event: ToolchainActionEventV1;
	status: OutboxStatus;
};

export const OUTBOX_TTL_MS = 24 * 60 * 60 * 1000;
export const OUTBOX_MAX_ENTRIES = 32;
const MAX_ENTRIES = OUTBOX_MAX_ENTRIES;
const VERSION = "eumenes.toolchain-outbox.v1";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function sessionStore(): Store | null {
	try {
		return window.sessionStorage;
	} catch {
		return null;
	}
}

export type Outbox = ReturnType<typeof createOutbox>;

/**
 * sessionStorage is optional: a private window or blocked site data leaves a memory-only outbox
 * for this page, which still deduplicates resends until the page is reloaded.
 */
export function createOutbox(
	identity: string,
	store: Store | null = sessionStore(),
) {
	const key = `${VERSION}:${identity}`;
	let memory: OutboxEntry[] = [];
	function read(): OutboxEntry[] {
		if (!store) return memory;
		try {
			const raw = store.getItem(key);
			if (!raw) return [];
			const rows: unknown = JSON.parse(raw);
			if (!Array.isArray(rows)) return [];
			return rows.flatMap((row): OutboxEntry[] => {
				const event = toolchainActionEventV1.safeParse(row?.event);
				const status = row?.status;
				return event.success &&
					["sending", "pending", "indeterminate", "retry"].includes(status)
					? [{ event: event.data, status }]
					: [];
			});
		} catch {
			return memory;
		}
	}
	function write(entries: OutboxEntry[]) {
		memory = entries;
		if (!store) return;
		try {
			if (entries.length === 0) store.removeItem(key);
			else
				store.setItem(
					key,
					JSON.stringify(
						entries.map(({ event, status }) => ({ event, status })),
					),
				);
		} catch {
			// The memory copy keeps this page correct; only a reload loses it.
		}
	}
	return {
		list: read,
		get: (eventId: string) =>
			read().find((entry) => entry.event.eventId === eventId),
		/**
		 * Adds or replaces an entry. Every entry is an operation of unknown outcome, so none is
		 * dropped to make room: a new entry beyond the cap is refused (false) instead.
		 */
		put(entry: OutboxEntry): boolean {
			const all = read();
			const rest = all.filter(
				(row) => row.event.eventId !== entry.event.eventId,
			);
			if (rest.length === all.length && all.length >= MAX_ENTRIES) return false;
			write([...rest, entry]);
			return true;
		},
		setStatus(eventId: string, status: OutboxStatus) {
			write(
				read().map((row) =>
					row.event.eventId === eventId ? { ...row, status } : row,
				),
			);
		},
		remove(eventId: string) {
			write(read().filter((row) => row.event.eventId !== eventId));
		},
		/**
		 * An unsettled entry for the same logical operation, to resend with its original id,
		 * times and input instead of making a second operation.
		 */
		reusable(like: {
			artifactRevisionId: string;
			actionId: string;
			source: string;
			targetRef: string | undefined;
			input: unknown;
		}): OutboxEntry | undefined {
			const input = JSON.stringify(like.input);
			return read().find(
				({ event }) =>
					event.artifactRevisionId === like.artifactRevisionId &&
					event.actionId === like.actionId &&
					event.source === like.source &&
					event.targetRef === like.targetRef &&
					JSON.stringify(event.input) === input,
			);
		},
		/** Entries issued under another scope: never resent or reconciled by this session. */
		foreignScope(scopeRef: string, artifactRevisionId: string) {
			return read().filter(
				({ event }) =>
					event.artifactRevisionId === artifactRevisionId &&
					event.scopeRef !== scopeRef,
			);
		},
	};
}
