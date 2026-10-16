import type {
	ActionRequestView,
	ExecutionResultV1,
	FieldError,
	ToolchainActionEventV1,
} from "../../../../api/domains/tool-runtime/contracts";
import type { EumenesClient } from "../../../../client";
import { ApiError } from "../../../../client/transport";
import { OUTBOX_MAX_ENTRIES, OUTBOX_TTL_MS, type Outbox } from "./outbox";

/**
 * How one write action ended, from the host's point of view.
 * `pending` (accepted for later settlement) and `indeterminate` (the answer never arrived) are
 * both unsettled: the same eventId and input are reconciled, and no new operation is made.
 */
export type ActionOutcome =
	| { kind: "accepted"; result: ExecutionResultV1 | undefined }
	| {
			kind: "rejected";
			code: string | undefined;
			fieldErrors: FieldError[];
			conflict: boolean;
	  }
	| { kind: "pending" }
	| { kind: "indeterminate" };

export type ActionDraft = {
	/**
	 * false for an event holding secrets: it is never written to the outbox, never resent, and
	 * an unknown outcome is reported as such instead of reconciled.
	 */
	persist?: boolean;
	actionId: string;
	source: string;
	sourceRevision: number;
	targetRef: string | undefined;
	input: unknown;
};

export type ActionApi = Pick<
	EumenesClient,
	"submitToolchainAction" | "toolchainAction" | "unsettledToolchainActions"
>;

/** A request that has not answered by then is an unknown outcome and enters reconciliation. */
const SEND_TIMEOUT_MS = 15_000;

/** Reconcile a few times after an unknown outcome, then wait for reconnect, focus or a resend. */
export const RECONCILE_DELAYS_MS = [2_000, 6_000, 15_000] as const;

export type ActionDispatcherOptions = {
	client: ActionApi;
	outbox: Outbox;
	artifactId: string;
	artifactRevisionId: string;
	/** The scope the artifact was issued under; entries of another scope are never resent. */
	scopeRef: string;
	/** An unsettled operation ended without the user waiting for it. */
	onSettled(event: ToolchainActionEventV1, outcome: ActionOutcome): void;
	/** Entries that can no longer be reconciled and were dropped. */
	onDiscarded(events: ToolchainActionEventV1[]): void;
	/** Unsettled operations the server knows that this tab does not. */
	onUnknown?(count: number): void;
	now?: () => number;
	newId?: () => string;
	after?: (ms: number, run: () => void) => () => void;
};

const defaultAfter = (ms: number, run: () => void) => {
	const id = setTimeout(run, ms);
	return () => clearTimeout(id);
};

export function createActionDispatcher(options: ActionDispatcherOptions) {
	const { client, outbox, artifactRevisionId } = options;
	const now = options.now ?? Date.now;
	const newId = options.newId ?? (() => crypto.randomUUID());
	const after = options.after ?? defaultAfter;
	const inflight = new Map<string, Promise<ActionOutcome>>();
	const timers = new Map<string, () => void>();
	const attempts = new Map<string, number>();
	let disposed = false;

	const expired = (event: ToolchainActionEventV1) =>
		Date.parse(event.eventExpiresAt) <= now();

	function classify(view: ActionRequestView): ActionOutcome {
		switch (view.status) {
			case "accepted":
				return { kind: "accepted", result: view.result };
			case "rejected":
				return {
					kind: "rejected",
					code: view.errorCode,
					fieldErrors: view.fieldErrors ?? [],
					conflict: view.errorCode === "revision_conflict",
				};
			case "pending":
				return { kind: "pending" };
			default:
				return { kind: "indeterminate" };
		}
	}

	function fromError(error: unknown): ActionOutcome {
		if (error instanceof ApiError) {
			// The host's 503 refusals carry a safe code and happen before anything is saved;
			// a 503 without one (a proxy, a restart) is an unknown outcome.
			const hostRefusal =
				error.status === 503 && /^[a-z][a-z_]*$/.test(error.message);
			if (
				(error.status >= 400 && error.status < 500 && error.status !== 429) ||
				hostRefusal
			)
				return {
					kind: "rejected",
					code: error.message,
					fieldErrors: fieldErrorsOf(error.body),
					conflict: error.message === "revision_conflict",
				};
		}
		return { kind: "indeterminate" };
	}

	/** Records the end of an operation: settled ones leave the outbox, unsettled ones stay. */
	function record(event: ToolchainActionEventV1, outcome: ActionOutcome) {
		const eventId = event.eventId;
		if (outcome.kind === "accepted") outbox.remove(eventId);
		else if (outcome.kind === "rejected") {
			// A capacity refusal stored nothing; the same event may be offered again.
			if (outcome.code === "action_capacity")
				outbox.setStatus(eventId, "retry");
			else outbox.remove(eventId);
		} else outbox.setStatus(eventId, outcome.kind);
		if (outcome.kind === "pending" || outcome.kind === "indeterminate")
			schedule(eventId);
		else {
			cancel(eventId);
			attempts.delete(eventId);
		}
	}

	function cancel(eventId: string) {
		timers.get(eventId)?.();
		timers.delete(eventId);
	}

	/** Reconcile a few times with growing gaps; later ones wait for reconnect, focus or a resend. */
	function schedule(eventId: string) {
		if (disposed || timers.has(eventId)) return;
		const attempt = attempts.get(eventId) ?? 0;
		const delay = RECONCILE_DELAYS_MS[attempt];
		if (delay === undefined) return;
		attempts.set(eventId, attempt + 1);
		timers.set(
			eventId,
			after(delay, () => {
				timers.delete(eventId);
				void reconcile(eventId, true);
			}),
		);
	}

	/** One POST of the event; the server replays the stored result for the same id and input. */
	async function submit(event: ToolchainActionEventV1): Promise<ActionOutcome> {
		let outcome: ActionOutcome;
		try {
			const submitted = await client.submitToolchainAction(
				event,
				AbortSignal.timeout(SEND_TIMEOUT_MS),
			);
			outcome =
				submitted.httpStatus === 202 && submitted.view.status === "accepted"
					? { kind: "pending" }
					: classify(submitted.view);
		} catch (error) {
			outcome = fromError(error);
		}
		record(event, outcome);
		return outcome;
	}

	/** Sends the event (again), once at a time per eventId. */
	function post(event: ToolchainActionEventV1): Promise<ActionOutcome> {
		const running = inflight.get(event.eventId);
		if (running) return running;
		const promise = submit(event).finally(() => inflight.delete(event.eventId));
		inflight.set(event.eventId, promise);
		return promise;
	}

	/**
	 * Asks the server for the stored result of an event. A missing record (404) does not prove
	 * the operation never ran or never will: the original event is sent again, unchanged.
	 */
	async function reconcile(
		eventId: string,
		background: boolean,
	): Promise<ActionOutcome | undefined> {
		const entry = outbox.get(eventId);
		if (!entry || disposed) return undefined;
		const event = entry.event;
		const running = inflight.get(eventId);
		if (running) return running;
		const promise = (async (): Promise<ActionOutcome> => {
			let outcome: ActionOutcome;
			try {
				outcome = classify(
					await client.toolchainAction(
						eventId,
						AbortSignal.timeout(SEND_TIMEOUT_MS),
					),
				);
			} catch (error) {
				if (error instanceof ApiError && error.status === 404) {
					if (expired(event)) {
						outbox.remove(eventId);
						options.onDiscarded([event]);
						return { kind: "indeterminate" };
					}
					return submit(event);
				}
				outcome = fromError(error);
				// A refusal of the lookup itself says nothing about the operation.
				if (outcome.kind === "rejected") outcome = { kind: "indeterminate" };
			}
			record(event, outcome);
			return outcome;
		})().finally(() => inflight.delete(eventId));
		inflight.set(eventId, promise);
		const outcome = await promise;
		// Only a settlement is news; an operation that is still unknown stays in the outbox.
		if (
			background &&
			!disposed &&
			outcome.kind !== "indeterminate" &&
			outcome.kind !== "pending"
		)
			options.onSettled(event, outcome);
		return outcome;
	}

	function eventOf(
		draft: ActionDraft,
		eventId: string,
		created: number,
	): ToolchainActionEventV1 {
		return {
			version: 1,
			eventId,
			eventCreatedAt: new Date(created).toISOString(),
			eventExpiresAt: new Date(created + OUTBOX_TTL_MS).toISOString(),
			artifactId: options.artifactId,
			artifactRevisionId,
			source: draft.source,
			sourceRevision: draft.sourceRevision,
			...(draft.targetRef ? { targetRef: draft.targetRef } : {}),
			actionId: draft.actionId,
			scopeRef: options.scopeRef,
			input: draft.input,
		};
	}

	return {
		/** Saves the event in the outbox, then sends it. A resend of the same operation reuses it. */
		async send(draft: ActionDraft): Promise<ActionOutcome> {
			if (draft.persist === false) {
				// Secrets: one send, kept nowhere. An unknown outcome is left to the user.
				const created = now();
				try {
					const submitted = await client.submitToolchainAction(
						eventOf(draft, newId(), created),
						AbortSignal.timeout(SEND_TIMEOUT_MS),
					);
					return submitted.httpStatus === 202 &&
						submitted.view.status === "accepted"
						? { kind: "pending" }
						: classify(submitted.view);
				} catch (error) {
					return fromError(error);
				}
			}
			const previous = outbox.reusable({
				artifactRevisionId,
				actionId: draft.actionId,
				source: draft.source,
				targetRef: draft.targetRef,
				input: draft.input,
			});
			let event: ToolchainActionEventV1;
			if (previous && !expired(previous.event)) {
				event = previous.event;
			} else {
				if (previous) {
					outbox.remove(previous.event.eventId);
					options.onDiscarded([previous.event]);
				}
				event = eventOf(draft, newId(), now());
			}
			cancel(event.eventId);
			attempts.delete(event.eventId);
			if (outbox.list().length >= OUTBOX_MAX_ENTRIES) {
				// Only operations past their expiry make room, and the user is told.
				const stale = outbox.list().filter((row) => expired(row.event));
				for (const row of stale) outbox.remove(row.event.eventId);
				if (stale.length) options.onDiscarded(stale.map((row) => row.event));
			}
			if (!outbox.put({ event, status: "sending" })) {
				// Nothing was sent: the operations already left unconfirmed come first.
				return {
					kind: "rejected",
					code: "outbox_full",
					fieldErrors: [],
					conflict: false,
				};
			}
			return post(event);
		},
		/**
		 * On mount, reconnect or focus: drop what can no longer be sent, then ask the server about
		 * everything else this tab left unsettled. Never a periodic poll.
		 */
		async reconcileAll() {
			if (disposed) return;
			const dropped = outbox.foreignScope(options.scopeRef, artifactRevisionId);
			for (const { event } of dropped) {
				cancel(event.eventId);
				outbox.remove(event.eventId);
			}
			if (dropped.length) options.onDiscarded(dropped.map((row) => row.event));
			const mine = outbox
				.list()
				.filter((row) => row.event.artifactRevisionId === artifactRevisionId);
			for (const row of mine) attempts.delete(row.event.eventId);
			await Promise.all(mine.map((row) => reconcile(row.event.eventId, true)));
			if (options.onUnknown) {
				try {
					const known = new Set(outbox.list().map((row) => row.event.eventId));
					const unknown = (await client.unsettledToolchainActions()).filter(
						(view) => !known.has(view.eventId),
					);
					if (unknown.length) options.onUnknown(unknown.length);
				} catch {
					// The lookup is best effort; the per-event reconciliation above is authoritative.
				}
			}
		},
		/** Unsettled operations of this artifact, for display. */
		unsettled: () =>
			outbox
				.list()
				.filter((row) => row.event.artifactRevisionId === artifactRevisionId),
		/** Begins (or resumes, after React re-mounts the host) reconciling what is unsettled. */
		start() {
			disposed = false;
			return this.reconcileAll();
		},
		stop() {
			disposed = true;
			for (const eventId of timers.keys()) cancel(eventId);
		},
	};
}
export type ActionDispatcher = ReturnType<typeof createActionDispatcher>;

function fieldErrorsOf(body: unknown): FieldError[] {
	const rows =
		body && typeof body === "object" && "fieldErrors" in body
			? (body as { fieldErrors: unknown }).fieldErrors
			: [];
	if (!Array.isArray(rows)) return [];
	return rows.flatMap((row) =>
		row &&
		typeof row === "object" &&
		typeof (row as FieldError).field === "string" &&
		typeof (row as FieldError).message === "string"
			? [
					{
						field: (row as FieldError).field,
						message: (row as FieldError).message,
					},
				]
			: [],
	);
}
