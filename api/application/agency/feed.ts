import type { Database } from "bun:sqlite";
import type { AgencyRuntime, Opportunity, InputContext } from "eumenes-agency";
import { combineInput, currentInput, observationInput } from "./input";
import type { OutboxEvent } from "../../domains/conversation";
import { imageReferenceText } from "../../domains/conversation";
import { toErrorCode } from "../../infrastructure/error-code";
import { getLogger } from "../../infrastructure/logger";
import type { createConversationLifecycle } from "./conversation-lifecycle";
import type { AgencyHostDeps, Conv } from "./host-types";
import type { AgencyWork } from "./work";
const log = getLogger("agency");
/** Outbox events read per pass. */
const FEED_PAGE = 200;
type Pending = { turnEnd: boolean };
export function createAgencyFeed(input: {
	deps: AgencyHostDeps;
	convs: Map<string, Conv>;
	state: { activeId: string | null; cursor: number };
	nowMs: () => number;
	on: () => boolean;
	todosNow: (c: Conv) => ReturnType<AgencyWork["todosInTransaction"]>;
	launch: (c: Conv, trigger: Opportunity["trigger"]) => void;
	trackSave: (c: Conv) => void;
	retract(c: Conv, sourceId: string): Promise<void>;
	collectReturns: () => void;
	inflight: Set<Promise<unknown>>;
	lifecycle: Pick<
		ReturnType<typeof createConversationLifecycle>,
		"convOf" | "dropConv" | "invalidate" | "activate" | "prune"
	>;
}) {
	const {
		deps,
		convs,
		state,
		nowMs,
		on,
		todosNow,
		launch,
		trackSave,
		collectReturns,
		inflight,
	} = input;
	const { convOf, dropConv, invalidate, activate, prune } = input.lifecycle;
	const { store, conversation } = deps;
	const workChanged = new Set<string>();

	/**
	 * Whether the conversation holds a question the agent was not yet given an opportunity for (finished work is told
	 * by its notice on screen). A transaction that told of work and then rolled back changed no TODO, so it opens
	 * nothing.
	 */
	function newWork(c: Conv) {
		const now = new Set(
			todosNow(c).flatMap((todo) =>
				todo.status === "waiting"
					? [`${todo.id}:waiting:${todo.question}`]
					: [],
			),
		);
		const fresh = [...now].some((key) => !c.reportable.has(key));
		c.reportable = now;
		if (fresh)
			observe(
				c,
				{
					id: `work:${crypto.randomUUID()}`,
					kind: "source.changed",
					actor: "host",
					occurredAt: nowMs(),
					text: JSON.stringify({
						todos: todosNow(c).map(({ input: _input, ...todo }) => todo),
					}),
				},
				combineInput(
					...todosNow(c).map(
						(todo) => todo.input ?? { sources: [], complete: false },
					),
				),
			);
		return fresh;
	}

	function observe(
		c: Conv,
		input: Parameters<AgencyRuntime["observe"]>[0],
		context: InputContext,
	) {
		try {
			// Reject an unusable source before it can poison every later update's input.
			if (!store.read((db) => currentInput(deps, db, context)))
				throw new Error("agency_input_stale");
			c.runtime.observe(input, context);
			log.info("agency.observation_received", {
				subjectId: c.id,
				kind: input.kind,
				source: input.actor,
				outputCharacters: input.text.length,
			});
		} catch (error) {
			log.warn("agency.observation_received", {
				subjectId: c.id,
				kind: input.kind,
				outcome: "rejected",
				reason: toErrorCode(error, "observe_failed"),
			});
		}
	}

	function handle(
		db: Database,
		event: OutboxEvent,
		pending: Map<string, Pending>,
	) {
		if (event.namespace !== "conversation" || event.sourceKind !== "message")
			return;
		if (event.kind === "retracted") {
			const c = convs.get(event.conversationId);
			if (!c) return;
			const task = input.retract(c, event.sourceId).then(() => trackSave(c));
			inflight.add(task);
			void task.finally(() => inflight.delete(task));
			pending.delete(c.id);
			return;
		}
		// Our own utterances reach the ledger through their receipt.
		if (event.sourceId.startsWith("agency:")) return;
		const source = conversation.sourceInTransaction(db, event.sourceId);
		if (source.state !== "available") return;
		const message = source.message;
		if (deps.memory.isBlockedInTransaction?.(db, message.id)) return;
		const c = convOf(event.conversationId);
		c.touched = nowMs();
		const occurredAt = Date.parse(event.occurredAt);
		const at = Number.isFinite(occurredAt) ? occurredAt : nowMs();
		const speaker = event.speaker;
		const imageRefs = conversation
			.imageReferencesInTransaction(db, message.id)
			.filter(
				(ref) => !deps.memory.isBlockedInTransaction?.(db, ref.messageId),
			);
		if (event.kind === "added" && speaker === "user") {
			invalidate(c, "input.changed");
			c.planner.userTurn(nowMs());
			activate(c);
			c.scheduler.rearm();
			pending.set(c.id, { turnEnd: false });
		}
		if (
			message.presentation !== "artifact" &&
			(message.text.trim() !== "" || imageRefs.length > 0)
		)
			observe(
				c,
				{
					id:
						event.kind === "added"
							? event.sourceId
							: `${event.sourceId}:c${event.seq}`,
					kind: event.kind === "added" ? "exchange.adopted" : "correction",
					actor: speaker === "user" ? "user" : "agent",
					occurredAt: at,
					text: [message.text, imageReferenceText(imageRefs)]
						.filter(Boolean)
						.join("\n"),
				},
				combineInput(
					observationInput(deps, db, message.id),
					...imageRefs.map((ref) => observationInput(deps, db, ref.messageId)),
					speaker === "assistant" &&
						message.runId &&
						deps.memory.referenceInputs
						? (deps.memory.referenceInputs.readRunInTransaction(
								db,
								message.runId,
							) ?? { sources: [], complete: false })
						: { sources: [], complete: true },
				),
			);
		if (event.kind === "added" && speaker === "assistant") {
			// A new silence starts at every assistant message (also a timer's announcement).
			c.planner.enter();
			c.planner.leave(nowMs());
			c.scheduler.rearm();
			if (message.runId !== null) pending.set(c.id, { turnEnd: true });
		}
	}

	/** Reads and handles every new outbox event in order, then opens the turn-end opportunities. */
	function pump() {
		if (!on()) return;
		if (deps.state) {
			for (const c of convs.values())
				if (
					store.read((db) => deps.state!.epochInTransaction(db, c.id)) !==
					c.epoch
				)
					dropConv(c, "source_forgotten");
			collectReturns();
		}
		const before = state.cursor;
		const pending = new Map<string, Pending>();
		for (;;) {
			const page = store.read((db) => {
				const events = conversation.changesInTransaction(
					db,
					state.cursor,
					FEED_PAGE,
				);
				for (const event of events) {
					state.cursor = event.seq;
					try {
						handle(db, event, pending);
					} catch (error) {
						log.warn("agency.feed_event_failed", {
							subjectId: event.conversationId,
							reason: toErrorCode(error, "event_failed"),
						});
					}
				}
				return events.length;
			});
			if (page < FEED_PAGE) break;
		}
		for (const [conversationId, pendingState] of pending) {
			const c = convs.get(conversationId);
			// Every scope may consider silent work on its own input; speech still requires the active display.
			if (pendingState.turnEnd && c) {
				workChanged.delete(conversationId);
				newWork(c);
				launch(c, "turn_end");
			}
		}
		// A question is asked where the user is talking; elsewhere it waits for the next turn there.
		for (const conversationId of workChanged) {
			if (conversationId !== state.activeId) continue;
			const c = convOf(conversationId);
			if (newWork(c)) launch(c, "result_received");
		}
		workChanged.clear();
		prune();
		if (state.cursor !== before) for (const c of convs.values()) trackSave(c);
	}

	function safePump() {
		try {
			pump();
		} catch (error) {
			log.warn("agency.feed_failed", {
				reason: toErrorCode(error, "feed_failed"),
			});
		}
	}
	return { safePump, workChanged };
}
