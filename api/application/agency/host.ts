import type { Database } from "bun:sqlite";
import {
	createAgencyRuntime,
	createIdlePlanner,
	createIdleScheduler,
	ttsUtteranceStyle,
	type ActionTicket,
	type AgencyRuntime,
	type CallOutcome,
	type CycleOutcome,
	type Decision,
	type IdlePlanner,
	type LlmPort,
	type LlmRequest,
	type Opportunity,
} from "eumenes-agency";
import type {
	ConversationService,
	OutboxEvent,
} from "../../domains/conversation";
import type {
	AgencyContext,
	AgencyContextUtterance,
	AgencyLayerPort,
} from "../../domains/dialogue/contracts";
import type { MemoryService } from "../../domains/memory";
import type { Settings } from "../../domains/settings";
import { toErrorCode } from "../../infrastructure/error-code";
import { getLogger } from "../../infrastructure/logger";
import type { SqliteStore } from "../../infrastructure/sqlite";
import { type AgencyCallIdentity, AgencyRouteRefusedError } from "./llm-port";
import { selectMemoryTopics } from "./topics";

export type AgencySettings = Settings["agency"];

/** Delivered utterances kept per conversation for the main context (older ones are never shown). */
const DELIVERED_KEPT = 5;
/** A conversation the user has not touched for this long, and is not the active one, is forgotten. */
const IDLE_DROP_MS = 30 * 60_000;
/** Tracked conversations at most; the least recently touched inactive ones go first. */
const MAX_CONVERSATIONS = 20;
/** Topics are re-read from memory at most this often. */
const TOPICS_TTL_MS = 30_000;
/** Outbox events read per pass. */
const FEED_PAGE = 200;
const LOG_REASON_CHARS = 120;

export type AgencyHostDeps = {
	store: Pick<SqliteStore, "read" | "write" | "onCommit">;
	conversation: Pick<
		ConversationService,
		| "changesInTransaction"
		| "outboxHeadInTransaction"
		| "sourceInTransaction"
		| "latestOrdinalInTransaction"
		| "nthLatestUserOrdinalInTransaction"
		| "appendInTransaction"
	>;
	/** `foregroundBusy()` serves the user right now (conversation answers, ASR, TTS); background calls never count. */
	inference: { foregroundBusy(): boolean };
	settings: {
		get(): { agency: AgencySettings };
		/** The committed settings as the transaction sees them (the delivery fence reads this, not the cache). */
		inTransaction(db: Database): { agency: AgencySettings };
		onChange(listener: () => void): () => void;
	};
	/** The user's State items are the topic material (hostTopics mode). */
	memory: Pick<MemoryService, "status" | "list">;
	/**
	 * Builds the background LLM port of one conversation. `next` names each call (unique decision id, the
	 * conversation's current execution generation); the host wraps the port to log and to catch route refusals.
	 */
	createLlm(
		next: (request: LlmRequest<unknown>) => AgencyCallIdentity,
	): LlmPort;
	/** True when the conversation has a queued or running run (inside a transaction, read-only). */
	conversationBusy(db: Database, conversationId: string): boolean;
	nowMs?(): number;
	setTimer?(fn: () => void, ms: number): unknown;
	clearTimer?(handle: unknown): void;
};

type Conv = {
	id: string;
	/** Unique per runtime instance: ticket ids restart per runtime, message ids must not repeat. */
	scope: string;
	runtime: AgencyRuntime;
	planner: IdlePlanner;
	scheduler: ReturnType<typeof createIdleScheduler>;
	generation: number;
	background: AbortController | null;
	delivered: AgencyContextUtterance[];
	/** Why agency stopped for this conversation (route refused); null while running. */
	stopped: string | null;
	opportunities: number;
	calls: number;
	/** Last time the conversation had an event or a cycle (for forgetting idle conversations). */
	touched: number;
};

const sanitize = (id: string) =>
	id.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 60);
const sameSettings = (a: AgencySettings, b: AgencySettings) =>
	JSON.stringify(a) === JSON.stringify(b);

/**
 * The agency host of Eumenes: one eumenes-agency runtime per conversation, fed from the conversation outbox,
 * deciding after a reply ends and after silence, delivering its utterances as runless assistant messages.
 * Everything happens on the application's single-process event loop; the only await points are model calls
 * and the store writer.
 */
export function createAgencyHost(deps: AgencyHostDeps) {
	const { store, conversation, inference, memory } = deps;
	const log = getLogger("agency");
	const nowMs = deps.nowMs ?? Date.now;
	const setTimer =
		deps.setTimer ??
		((fn: () => void, ms: number) => {
			const handle = setTimeout(fn, ms);
			handle.unref?.();
			return handle;
		});
	const clearTimer =
		deps.clearTimer ??
		((handle: unknown) =>
			clearTimeout(handle as ReturnType<typeof setTimeout>));
	const boot = crypto.randomUUID().slice(0, 8);

	const convs = new Map<string, Conv>();
	let cfg: AgencySettings = deps.settings.get().agency;
	let cursor = 0;
	let activeId: string | null = null;
	let started = false;
	let closed = false;
	let scopeCounter = 0;
	const inflight = new Set<Promise<unknown>>();
	let topicsCache: {
		at: number;
		topics: ReturnType<typeof selectMemoryTopics>;
	} | null = null;
	const stoppers: Array<() => void> = [];

	const on = () => started && !closed && cfg.enabled;

	// ---- feed -------------------------------------------------------------

	/** The newest outbox seq now: a (re)started feed never reads the past. */
	function feedEnd(): number {
		return store.read((db) => conversation.outboxHeadInTransaction(db));
	}

	// ---- runtime / conversation state --------------------------------------

	function topicsNow() {
		const now = nowMs();
		if (
			topicsCache &&
			now - topicsCache.at < TOPICS_TTL_MS &&
			now >= topicsCache.at
		)
			return topicsCache.topics;
		try {
			const status = memory.status();
			const topics =
				status.enabled && status.healthy
					? selectMemoryTopics(memory.list(), now)
					: [];
			topicsCache = { at: now, topics };
			return topics;
		} catch (error) {
			log.warn("agency.topics_failed", {
				reason: toErrorCode(error, "failed"),
			});
			return [];
		}
	}

	function stopConversation(c: Conv, reason: string) {
		if (c.stopped) return;
		c.stopped = reason;
		c.planner.stop();
		c.background?.abort();
		c.background = null;
		c.runtime.invalidate("stopped", nowMs());
		log.warn("agency.stopped", { subjectId: c.id, reason });
	}

	function wrapLlm(c: Conv, scope: string): LlmPort {
		// Inference binds a decision id to its request for good: the id is unique for the host's lifetime
		// (boot id and runtime scope), however often a runtime is recreated.
		const inner = deps.createLlm((request) => ({
			decisionId: `${sanitize(c.id)}.${scope}.${request.purpose}.${++c.calls}`,
			generation: c.generation,
		}));
		const route = () => (cfg.resourceId ? "cloud" : "larm");
		return {
			async complete<T>(request: LlmRequest<T>, signal: AbortSignal) {
				try {
					const result = await inner.complete(request, signal);
					log.info("agency.llm_call", {
						subjectId: c.id,
						purpose: request.purpose,
						route: route(),
						outcome: "ok",
						promptTokens: result.inputTokens,
						completionTokens: result.outputTokens,
						cachedTokens: result.cacheReadTokens,
						durationMs: result.latencyMs,
					});
					return result;
				} catch (error) {
					// A refusal of a replaced runtime says nothing about the current one.
					if (error instanceof AgencyRouteRefusedError && c.scope === scope)
						stopConversation(c, `route_refused:${error.refusal}`);
					if (!signal.aborted)
						log.warn("agency.llm_call", {
							subjectId: c.id,
							purpose: request.purpose,
							route: route(),
							outcome: "failed",
							reason: toErrorCode(error, "llm_failed"),
						});
					throw error;
				}
			},
		};
	}

	function newScope() {
		return `${boot}-${++scopeCounter}`;
	}

	function newRuntime(c: Conv): AgencyRuntime {
		const interests = cfg.interests.map((text, index) => ({
			id: `i${index + 1}`,
			text,
		}));
		return createAgencyRuntime({
			condition: "B1",
			selectWhenEmpty: true,
			hostTopics: true,
			utteranceStyle: ttsUtteranceStyle,
			...(interests.length > 0 ? { standingInterests: interests } : {}),
			tools: [],
			llm: wrapLlm(c, c.scope),
		});
	}

	function newPlanner(id: string): IdlePlanner {
		const planner = createIdlePlanner(
			{ idleSec: cfg.idleSec, maxUnanswered: cfg.maxUnanswered },
			nowMs(),
		);
		// Only the conversation the user spoke in last gets idle cycles.
		planner.setPaused(id !== activeId, nowMs());
		return planner;
	}

	function newScheduler(c: Conv) {
		const planner = c.planner;
		return createIdleScheduler({
			planner,
			now: nowMs,
			setTimer,
			clearTimer,
			run: () => runCycle(c, "idle", false),
			onCycle: (outcome) =>
				log.info("agency.idle_cycle", {
					subjectId: c.id,
					outcome,
					...idleFields(planner),
				}),
		});
	}

	function convOf(id: string): Conv {
		const known = convs.get(id);
		if (known) return known;
		const c = {
			id,
			scope: newScope(),
			planner: newPlanner(id),
			generation: 1,
			background: null,
			delivered: [],
			stopped: null,
			opportunities: 0,
			calls: 0,
			touched: nowMs(),
		} as unknown as Conv;
		c.runtime = newRuntime(c);
		c.scheduler = newScheduler(c);
		convs.set(id, c);
		return c;
	}

	const idleFields = (planner: IdlePlanner) => {
		const status = planner.status();
		return {
			phase: status.blockedBy ?? "armed",
			count: status.unanswered,
			attempt: status.level,
			durationMs: status.nextIntervalSec * 1000,
		};
	};

	function abortBackground(c: Conv) {
		c.background?.abort();
		c.background = null;
	}

	/** New input: everything in flight for the conversation is stale. */
	function invalidate(c: Conv, reason: string) {
		c.generation++;
		abortBackground(c);
		c.runtime.invalidate(reason, nowMs());
		log.info("agency.invalidated", {
			subjectId: c.id,
			reason,
			generation: c.generation,
		});
	}

	function activate(c: Conv) {
		if (activeId !== c.id) {
			const previous = activeId ? convs.get(activeId) : undefined;
			if (previous) {
				previous.planner.setPaused(true, nowMs());
				previous.scheduler.rearm();
			}
			activeId = c.id;
		}
		c.planner.setPaused(false, nowMs());
	}

	/** Ends a conversation's runtime for good: in-flight work is stale and no timer is left. */
	function dropConv(c: Conv, reason: string) {
		c.generation++;
		abortBackground(c);
		c.runtime.invalidate(reason, nowMs());
		c.runtime.setEnabled(false);
		c.scheduler.dispose();
		convs.delete(c.id);
	}

	/** Starts a conversation over in place: new runtime, planner and scheduler, nothing stopped or delivered. */
	function resetConv(c: Conv, reason: string) {
		c.generation++;
		abortBackground(c);
		c.runtime.invalidate(reason, nowMs());
		c.runtime.setEnabled(false);
		c.scheduler.dispose();
		c.scope = newScope();
		c.delivered = [];
		c.stopped = null;
		c.planner = newPlanner(c.id);
		c.runtime = newRuntime(c);
		c.scheduler = newScheduler(c);
		c.scheduler.rearm();
		log.info("agency.invalidated", {
			subjectId: c.id,
			reason,
			generation: c.generation,
		});
	}

	/** Drops every conversation (settings change, OFF, close). */
	function resetAll(reason: string) {
		for (const c of convs.values()) dropConv(c, reason);
		activeId = null;
		topicsCache = null;
	}

	/** Forgets conversations nobody has touched for a long time, and the oldest beyond the bound. */
	function prune() {
		const now = nowMs();
		const idle = (c: Conv) => c.id !== activeId && c.background === null;
		for (const c of convs.values())
			if (idle(c) && now - c.touched > IDLE_DROP_MS)
				dropConv(c, "idle_expired");
		if (convs.size <= MAX_CONVERSATIONS) return;
		const oldest = [...convs.values()]
			.filter(idle)
			.sort((a, b) => a.touched - b.touched);
		for (const c of oldest) {
			if (convs.size <= MAX_CONVERSATIONS) break;
			dropConv(c, "capacity");
		}
	}

	// ---- opportunities ----------------------------------------------------

	const hostBusy = (c: Conv) =>
		inference.foregroundBusy() ||
		store.read((db) => deps.conversationBusy(db, c.id));

	function logCalls(c: Conv, calls: readonly CallOutcome[]) {
		for (const call of calls)
			if (call.code !== "applied" && call.code !== "no_change")
				log.info("agency.background_call", {
					subjectId: c.id,
					purpose: call.purpose,
					outcome: call.code,
					validationCode: call.rejectCodes.join(","),
				});
	}

	function logDecision(
		c: Conv,
		trigger: Opportunity["trigger"],
		decision: Decision,
		superseded: boolean,
	) {
		log.info("agency.decision", {
			subjectId: c.id,
			selectionId: decision.opportunityId,
			kind: trigger,
			decision: decision.action,
			source: decision.source,
			outcome: superseded ? "superseded" : "current",
			validationCode: decision.rejectCodes.join(","),
			// The model's own short rationale, cut; never a message body.
			reason: decision.reason.slice(0, LOG_REASON_CHARS),
		});
	}

	/** What one cycle works on: the runtime and planner it started with stay its own even if replaced. */
	type Cycle = {
		c: Conv;
		runtime: AgencyRuntime;
		planner: IdlePlanner;
		trigger: Opportunity["trigger"];
		controller: AbortController;
		mine: number;
		ordinal: number;
	};

	/** Returns true when the utterance was appended. */
	async function deliver(cy: Cycle, ticket: ActionTicket): Promise<boolean> {
		const { c, trigger } = cy;
		if (ticket.action !== "speak") {
			log.info("agency.delivered", {
				subjectId: c.id,
				attemptId: ticket.id,
				kind: trigger,
				outcome: "tool_not_supported",
			});
			receipt(cy, ticket, "failed", "no tool runtime");
			return false;
		}
		const text = ticket.utterance ?? "";
		const messageId = `agency:${c.scope}:${ticket.id}`;
		const at = nowMs();
		let outcome: "appended" | "stale";
		try {
			outcome = await store.write((db) => {
				// Re-checked inside the writer transaction: the setting as committed (not the cached copy),
				// and nothing may have been said since the opportunity.
				const committed = deps.settings.inTransaction(db).agency;
				if (
					text === "" ||
					!on() ||
					!committed.enabled ||
					!sameSettings(committed, cfg) ||
					c.stopped ||
					c.generation !== cy.mine ||
					c.runtime !== cy.runtime ||
					convs.get(c.id) !== c ||
					conversation.latestOrdinalInTransaction(db, c.id) !== cy.ordinal ||
					deps.conversationBusy(db, c.id)
				)
					return "stale";
				conversation.appendInTransaction(db, {
					id: messageId,
					conversationId: c.id,
					role: "assistant",
					text,
					createdAt: new Date(at).toISOString(),
					runId: null,
				});
				return "appended";
			});
		} catch (error) {
			log.warn("agency.delivered", {
				subjectId: c.id,
				attemptId: ticket.id,
				kind: trigger,
				outcome: "write_failed",
				reason: toErrorCode(error, "write_failed"),
			});
			receipt(cy, ticket, "failed", "");
			return false;
		}
		if (outcome === "stale") {
			log.info("agency.delivered", {
				subjectId: c.id,
				attemptId: ticket.id,
				kind: trigger,
				outcome: "interrupted",
			});
			receipt(cy, ticket, "interrupted", "");
			return false;
		}
		cy.planner.proactiveSpoke(nowMs());
		c.delivered.push({ messageId, text, heard: "full" });
		if (c.delivered.length > DELIVERED_KEPT)
			c.delivered.splice(0, c.delivered.length - DELIVERED_KEPT);
		log.info("agency.delivered", {
			subjectId: c.id,
			attemptId: ticket.id,
			kind: trigger,
			outcome: "appended",
			outputCharacters: text.length,
		});
		receipt(cy, ticket, "succeeded", text);
		return true;
	}

	/** One terminal receipt per ticket (S3), recorded on the runtime that issued it and only while it is current. */
	function receipt(
		cy: Cycle,
		ticket: ActionTicket,
		status: "succeeded" | "failed" | "interrupted",
		resultText: string,
	) {
		const { c } = cy;
		// A replaced runtime already interrupted its tickets; its late receipt belongs to nobody.
		if (c.runtime !== cy.runtime) {
			log.info("agency.receipt", {
				subjectId: c.id,
				attemptId: ticket.id,
				status,
				outcome: "dropped",
			});
			return;
		}
		try {
			cy.runtime.recordResult({
				ticketId: ticket.id,
				status,
				at: nowMs(),
				resultText,
			});
			log.info("agency.receipt", {
				subjectId: c.id,
				attemptId: ticket.id,
				status,
			});
		} catch (error) {
			log.warn("agency.receipt", {
				subjectId: c.id,
				attemptId: ticket.id,
				status,
				reason: toErrorCode(error, "receipt_failed"),
			});
		}
	}

	async function cycleBody(cy: Cycle, update: boolean): Promise<CycleOutcome> {
		const { c, runtime, trigger, controller } = cy;
		if (update) {
			logCalls(c, await runtime.runBackground(nowMs(), controller.signal));
			if (c.stopped) return "halted";
		}
		if (controller.signal.aborted) return "aborted";
		const opportunity: Opportunity = {
			id: `o${++c.opportunities}`,
			at: nowMs(),
			trigger,
			presence: "quiet",
			foregroundBusy: hostBusy(c),
			playerBusy: false,
			topics: topicsNow(),
		};
		const { decision, calls } = await runtime.decide(
			opportunity,
			controller.signal,
		);
		logCalls(c, calls);
		const superseded =
			!on() ||
			convs.get(c.id) !== c ||
			cy.mine !== c.generation ||
			controller.signal.aborted;
		logDecision(c, trigger, decision, superseded);
		if (c.stopped) return "halted";
		if (superseded) return "aborted";
		// A busy moment is not a silent one: it must not spend the idle backoff.
		if (decision.source === "host_blocked") return "aborted";
		if (!decision.ticket) return "silent";
		return (await deliver(cy, decision.ticket)) ? "spoke" : "silent";
	}

	async function cycle(
		c: Conv,
		trigger: Opportunity["trigger"],
		update: boolean,
	): Promise<CycleOutcome> {
		if (!on() || convs.get(c.id) !== c || c.stopped) return "halted";
		if (trigger === "idle" && hostBusy(c)) {
			// Wait one more interval at the same level.
			c.planner.enter();
			c.planner.leave(nowMs());
			return "aborted";
		}
		abortBackground(c);
		const controller = new AbortController();
		c.background = controller;
		c.touched = nowMs();
		const cy: Cycle = {
			c,
			runtime: c.runtime,
			planner: c.planner,
			trigger,
			controller,
			mine: ++c.generation,
			ordinal: store.read((db) =>
				conversation.latestOrdinalInTransaction(db, c.id),
			),
		};
		cy.planner.enter();
		let outcome: CycleOutcome = "silent";
		try {
			outcome = await cycleBody(cy, update);
		} catch (error) {
			if (c.stopped) outcome = "halted";
			else if (controller.signal.aborted) outcome = "aborted";
			else
				log.warn("agency.cycle_failed", {
					subjectId: c.id,
					kind: trigger,
					reason: toErrorCode(error, "cycle_failed"),
				});
		} finally {
			if (c.background === controller) c.background = null;
			cy.planner.leave(nowMs());
		}
		if (on() && convs.get(c.id) === c && c.planner === cy.planner)
			c.scheduler.rearm();
		return outcome;
	}

	/** Every cycle, whoever starts it (a turn end or the idle scheduler), is awaited by close(). */
	function runCycle(
		c: Conv,
		trigger: Opportunity["trigger"],
		update: boolean,
	): Promise<CycleOutcome> {
		const task = cycle(c, trigger, update);
		inflight.add(task);
		const done = () => inflight.delete(task);
		task.then(done, done);
		return task;
	}

	function launch(c: Conv, trigger: Opportunity["trigger"], update: boolean) {
		runCycle(c, trigger, update).catch((error) =>
			log.warn("agency.cycle_failed", {
				subjectId: c.id,
				reason: toErrorCode(error, "cycle_failed"),
			}),
		);
	}

	// ---- feed handling ----------------------------------------------------

	type Pending = { turnEnd: boolean };

	function observe(c: Conv, input: Parameters<AgencyRuntime["observe"]>[0]) {
		try {
			c.runtime.observe(input);
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
			// The core cannot forget one observation: the conversation's agency starts over without it
			// (new runtime and planner; nothing of the old idle backoff survives).
			resetConv(c, "retracted");
			pending.delete(c.id);
			return;
		}
		// Our own utterances reach the ledger through their receipt; a correction updates what we remember saying.
		if (event.sourceId.startsWith("agency:")) {
			if (event.kind === "corrected") {
				const utterance = convs
					.get(event.conversationId)
					?.delivered.find((u) => u.messageId === event.sourceId);
				const corrected = utterance
					? conversation.sourceInTransaction(db, event.sourceId)
					: null;
				if (utterance && corrected?.state === "available")
					utterance.text = corrected.message.text;
			}
			return;
		}
		const source = conversation.sourceInTransaction(db, event.sourceId);
		if (source.state !== "available") return;
		const message = source.message;
		const c = convOf(event.conversationId);
		c.touched = nowMs();
		const occurredAt = Date.parse(event.occurredAt);
		const at = Number.isFinite(occurredAt) ? occurredAt : nowMs();
		const speaker = event.speaker;
		if (event.kind === "added" && speaker === "user") {
			invalidate(c, "input.changed");
			c.planner.userTurn(nowMs());
			activate(c);
			c.scheduler.rearm();
			pending.set(c.id, { turnEnd: false });
		}
		if (message.presentation !== "artifact" && message.text.trim() !== "")
			observe(c, {
				id:
					event.kind === "added"
						? event.sourceId
						: `${event.sourceId}:c${event.seq}`,
				kind: event.kind === "added" ? "exchange.adopted" : "correction",
				actor: speaker === "user" ? "user" : "agent",
				occurredAt: at,
				text: message.text,
			});
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
		const pending = new Map<string, Pending>();
		for (;;) {
			const page = store.read((db) => {
				const events = conversation.changesInTransaction(db, cursor, FEED_PAGE);
				for (const event of events) {
					cursor = event.seq;
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
		for (const [conversationId, state] of pending) {
			const c = convs.get(conversationId);
			if (state.turnEnd && c && conversationId === activeId)
				launch(c, "turn_end", true);
		}
		prune();
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

	// ---- settings -----------------------------------------------------------

	function applySettings() {
		const next = deps.settings.get().agency;
		const previous = cfg;
		if (sameSettings(previous, next)) {
			// The cause of a route refusal may lie outside the agency section (cloud allowed, a connection, a
			// registered model): any settings change gives a stopped conversation a fresh start.
			for (const c of convs.values())
				if (c.stopped) resetConv(c, "settings.changed");
			return;
		}
		cfg = next;
		// Applied immediately: whatever was in flight or stopped belongs to the old setting.
		resetAll("settings.changed");
		if (next.enabled && !previous.enabled) cursor = feedEnd();
		log.info("agency.settings_applied", {
			outcome: next.enabled ? "on" : "off",
			route: next.resourceId ? "cloud" : "larm",
		});
	}

	// ---- public ---------------------------------------------------------------

	const dialoguePort: AgencyLayerPort = {
		recentForContextInTransaction(db, conversationId): AgencyContext | null {
			if (!on()) return null;
			// Only conversations the host tracks (it has seen the user speak in) show the layer.
			const c = convs.get(conversationId);
			if (!c) return null;
			const interests = [...cfg.interests];
			const utterances: AgencyContextUtterance[] = [];
			if (c.delivered.length > 0) {
				// Said since the user's previous message (the newest one is the input being answered).
				const boundary = conversation.nthLatestUserOrdinalInTransaction(
					db,
					conversationId,
					2,
				);
				for (const utterance of c.delivered) {
					const source = conversation.sourceInTransaction(
						db,
						utterance.messageId,
					);
					if (source.state === "available" && source.ordinal > boundary)
						utterances.push({ ...utterance });
				}
			}
			return utterances.length === 0 && interests.length === 0
				? null
				: { utterances, interests };
		},
	};

	return {
		/** Reads the settings, subscribes to commits and settings changes. The feed starts at its end. */
		start() {
			if (started || closed) return;
			started = true;
			cfg = deps.settings.get().agency;
			if (cfg.enabled) cursor = feedEnd();
			stoppers.push(deps.settings.onChange(applySettings));
			stoppers.push(store.onCommit(safePump));
		},
		async close() {
			if (closed) return;
			closed = true;
			for (const stop of stoppers.splice(0)) stop();
			resetAll("closed");
			await Promise.allSettled(inflight);
		},
		dialoguePort,
		/** Memory forgot something: the cached topics may name it. */
		invalidateTopics() {
			topicsCache = null;
		},
		/** Read-only diagnostics of one conversation's runtime (tests, support). */
		inspect(conversationId: string) {
			const c = convs.get(conversationId);
			return c
				? {
						snapshot: c.runtime.snapshot(),
						generation: c.generation,
						stopped: c.stopped,
						idle: c.planner.status(),
						delivered: [...c.delivered],
					}
				: null;
		},
	};
}
export type AgencyHost = ReturnType<typeof createAgencyHost>;
