import { createResultCollector } from "./returns";
import { logCalls, logDecision } from "./diagnostics";
import { createAgencyDelivery } from "./delivery";
import { hostPlanner, recoverTickets } from "./recovery";
import { createCheckpoint } from "./checkpoint";
import type {
	AgencyHostDeps,
	AgencySettings,
	HostPersona,
	Conv,
	Cycle,
} from "./host-types";
export type { AgencyHostDeps, AgencySettings } from "./host-types";
import { projectionLines, researchTools, waitingForWork } from "./research";
import type { AgencyRecord } from "../../domains/dialogue";
import type { AgencySnapshot, IdleCheckpoint } from "eumenes-agency";
import { deliveryEmotionOf } from "./speech";
import type { Database } from "bun:sqlite";
import {
	createIdleScheduler,
	emotionName,
	runRespond,
	type AgencyRuntime,
	type CycleOutcome,
	type IdlePlanner,
	type LlmPort,
	type LlmRequest,
	type Opportunity,
} from "eumenes-agency";
import type { OutboxEvent } from "../../domains/conversation";
import type {
	AgencyLayerPort,
	ConversationAgentPort,
} from "../../domains/dialogue/contracts";
import { toErrorCode } from "../../infrastructure/error-code";
import { getLogger } from "../../infrastructure/logger";
import { selectMemoryTopics } from "./topics";
import { agencyReplyParts } from "./system-context";
import { createHostRuntime } from "./runtime";
import type { AgencyWork } from "./work";

const samePersona = (a: HostPersona, b: HostPersona) =>
	a.agentName === b.agentName &&
	a.userName === b.userName &&
	a.persona === b.persona;

/** A conversation the user has not touched for this long, and is not the active one, is forgotten. */
const IDLE_DROP_MS = 30 * 60_000;
/** Tracked conversations at most; the least recently touched inactive ones go first. */
const MAX_CONVERSATIONS = 20;
/** Topics are re-read from memory at most this often. */
const TOPICS_TTL_MS = 30_000;
/** Outbox events read per pass. */
const FEED_PAGE = 200;

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
	let persona = deps.settings.get().general;
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
	/** The open TODOs of the conversation (the dialogue ledger); attached once the dialogue service exists. */
	let work: AgencyWork | null = null;
	const restored = new Map<string, AgencyRecord>();
	const digest = () => JSON.stringify({ agency: cfg, persona });
	const checkpoint = createCheckpoint({
		deps,
		inflight,
		convs,
		nowMs,
		digest,
		feed: () => ({ cursor, activeId }),
	});
	const save = checkpoint.save;
	const collectReturns = createResultCollector({
		deps,
		convs,
		convOf,
		dropConv,
		launch,
		nowMs,
		digest,
		inflight,
	});
	const trackSave = checkpoint.trackSave;

	function armReview(c: Conv) {
		if (!deps.state || !on() || c.reviewTimer !== undefined) return;
		c.reviewTimer = setTimer(() => {
			delete c.reviewTimer;
			if (!on() || convs.get(c.id) !== c) return;
			if (c.background) return armReview(c);
			void runCycle(c, "review_due").finally(() => armReview(c));
		}, 60_000);
	}

	const on = () => started && !closed;

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

	function todosNow(c: Conv) {
		if (!work) return [];
		try {
			return store.read((db) => work!.todosInTransaction(db, c.id));
		} catch (error) {
			log.warn("agency.todos_failed", {
				subjectId: c.id,
				reason: toErrorCode(error, "failed"),
			});
			return [];
		}
	}

	function wrapLlm(c: Conv, scope: string): LlmPort {
		// Inference binds a decision id to its request for good: the id is unique for the host's lifetime
		// (boot id and runtime scope), however often a runtime is recreated.
		const inner = deps.createLlm((request) => ({
			decisionId: `${sanitize(c.id)}.${scope}.${request.purpose}.${++c.calls}`,
			generation: c.generation,
			conversationId: c.id,
		}));
		return {
			async complete<T>(request: LlmRequest<T>, signal: AbortSignal) {
				try {
					const result = await inner.complete(request, signal);
					log.info("agency.llm_call", {
						subjectId: c.id,
						purpose: request.purpose,
						outcome: "ok",
						promptTokens: result.inputTokens,
						completionTokens: result.outputTokens,
						cachedTokens: result.cacheReadTokens,
						durationMs: result.latencyMs,
					});
					return result;
				} catch (error) {
					if (!signal.aborted)
						log.warn("agency.llm_call", {
							subjectId: c.id,
							purpose: request.purpose,
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

	function newRuntime(c: Conv, restore?: AgencySnapshot): AgencyRuntime {
		return createHostRuntime({
			agency: cfg,
			persona,
			...(restore ? { restore } : {}),
			tools: researchTools(store, deps.state),
			todos: () => todosNow(c),
			topics: topicsNow,
			llm: wrapLlm(c, newScope()),
		});
	}

	const newPlanner = (id: string, restore?: IdleCheckpoint) =>
		hostPlanner(id, cfg, activeId, nowMs(), restore);

	function newScheduler(c: Conv) {
		const planner = c.planner;
		return createIdleScheduler({
			planner,
			now: nowMs,
			setTimer,
			clearTimer,
			run: () => runCycle(c, "idle"),
			onCycle: (outcome) => {
				trackSave(c);
				log.info("agency.idle_cycle", {
					subjectId: c.id,
					outcome,
					...idleFields(planner),
				});
			},
		});
	}

	function convOf(id: string): Conv {
		const known = convs.get(id);
		if (known) return known;
		const previous =
			restored.get(id) ??
			(deps.state
				? store.read((db) =>
						deps
							.state!.recordsInTransaction(db)
							.find((r) => r.conversationId === id),
					)
				: undefined);
		restored.delete(id);
		const c = {
			epoch:
				previous?.epoch ??
				(deps.state
					? store.read((db) => deps.state!.epochInTransaction(db, id))
					: 0),
			id,
			scope: previous?.scope ?? newScope(),
			planner: newPlanner(id, previous?.idle as IdleCheckpoint | undefined),
			generation: 1,
			background: null,
			opportunities: 0,
			calls: 0,
			touched: nowMs(),
			reportable: new Set<string>(),
		} as unknown as Conv;
		c.runtime = newRuntime(c, previous?.snapshot as AgencySnapshot | undefined);
		if (previous && previous.settingsDigest !== digest())
			c.runtime.invalidate("settings.changed", nowMs());
		c.scheduler = newScheduler(c);
		convs.set(id, c);
		armReview(c);
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
		if (c.reviewTimer !== undefined) clearTimer(c.reviewTimer);
		c.generation++;
		abortBackground(c);
		c.runtime.invalidate(reason, nowMs());
		c.runtime.setEnabled(false);
		c.scheduler.dispose();
		convs.delete(c.id);
	}

	/** Starts a conversation over in place: new runtime, planner and scheduler. */
	function resetConv(c: Conv, reason: string) {
		if (deps.state)
			c.epoch = store.read((db) => deps.state!.epochInTransaction(db, c.id));
		c.generation++;
		abortBackground(c);
		c.runtime.invalidate(reason, nowMs());
		c.runtime.setEnabled(false);
		c.scheduler.dispose();
		c.scope = newScope();
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

	const speechAllowed = (c: Conv) =>
		c.id === activeId && c.planner.checkpoint().unanswered < cfg.maxUnanswered;

	const { deliver } = createAgencyDelivery({
		deps,
		nowMs,
		save,
		isCurrent: (cy, db, action) => {
			const { c } = cy;
			const committed = deps.settings.inTransaction(db);
			return (
				on() &&
				(action !== "speak" || speechAllowed(c)) &&
				sameSettings(committed.agency, cfg) &&
				samePersona(committed.general, persona) &&
				c.generation === cy.mine &&
				c.runtime === cy.runtime &&
				convs.get(c.id) === c &&
				conversation.latestOrdinalInTransaction(db, c.id) === cy.ordinal &&
				!deps.conversationBusy(db, c.id) &&
				!inference.foregroundBusy()
			);
		},
	});

	async function cycleBody(cy: Cycle): Promise<CycleOutcome> {
		const { c, runtime, trigger, controller } = cy;
		if (controller.signal.aborted) return "aborted";
		const opportunity: Opportunity = {
			id: `o${++c.opportunities}`,
			at: nowMs(),
			trigger,
			presence: "quiet",
			foregroundBusy: hostBusy(c),
			playerBusy: false,
			speechAllowed: speechAllowed(c),
			topics: topicsNow(),
			todos: todosNow(c),
		};
		const result =
			trigger === "review_due"
				? await runtime.wake!(
						nowMs(),
						{
							presence: "quiet",
							foregroundBusy: hostBusy(c),
							speechAllowed: speechAllowed(c),
						},
						controller.signal,
					)
				: await runtime.decide(opportunity, controller.signal);
		const { calls } = result;
		const decision = result.decision;
		logCalls(c, calls);
		if (!decision) return "silent";
		const superseded =
			!on() ||
			convs.get(c.id) !== c ||
			cy.mine !== c.generation ||
			controller.signal.aborted ||
			// A call cut off from below (yielded to the foreground) is not a silent moment: it must not spend the
			// idle backoff.
			calls.some((call) => call.code === "aborted");
		logDecision(c, trigger, decision, superseded);
		if (superseded) return "aborted";
		// Host limits defer an opportunity; they do not spend the speech backoff.
		if (["host_blocked", "host_budget"].includes(decision.source))
			return "aborted";
		if (!decision.ticket) return "silent";
		if (!(await save(c))) return "aborted";
		const delivered = await deliver(cy, decision.ticket, decision.evidenceRefs);
		if (decision.ticket.action === "tool") return "aborted";
		return delivered ? "spoke" : "silent";
	}

	async function cycle(
		c: Conv,
		trigger: Opportunity["trigger"],
	): Promise<CycleOutcome> {
		if (!on() || convs.get(c.id) !== c) return "halted";
		if (
			trigger === "idle" &&
			(c.background || hostBusy(c) || waitingForWork(c.runtime))
		) {
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
		if (trigger !== "review_due") cy.planner.enter();
		let outcome: CycleOutcome = "silent";
		try {
			outcome = await cycleBody(cy);
		} catch (error) {
			if (controller.signal.aborted) outcome = "aborted";
			else
				log.warn("agency.cycle_failed", {
					subjectId: c.id,
					kind: trigger,
					reason: toErrorCode(error, "cycle_failed"),
				});
		} finally {
			if (c.background === controller) c.background = null;
			if (trigger !== "review_due") cy.planner.leave(nowMs());
			if (convs.get(c.id) === c) await save(c);
		}
		if (on() && convs.get(c.id) === c && c.planner === cy.planner)
			c.scheduler.rearm();
		return outcome;
	}

	/** Every cycle, whoever starts it (a turn end or the idle scheduler), is awaited by close(). */
	function runCycle(
		c: Conv,
		trigger: Opportunity["trigger"],
	): Promise<CycleOutcome> {
		const task = cycle(c, trigger);
		inflight.add(task);
		const done = () => inflight.delete(task);
		task.then(done, done);
		return task;
	}

	function launch(c: Conv, trigger: Opportunity["trigger"]) {
		runCycle(c, trigger).catch((error) =>
			log.warn("agency.cycle_failed", {
				subjectId: c.id,
				reason: toErrorCode(error, "cycle_failed"),
			}),
		);
	}

	// ---- feed handling ----------------------------------------------------

	type Pending = { turnEnd: boolean };
	/** Conversations whose TODOs ask something, told inside a transaction: opened after its commit. */
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
			observe(c, {
				id: `work:${crypto.randomUUID()}`,
				kind: "source.changed",
				actor: "host",
				occurredAt: nowMs(),
				text: JSON.stringify({ todos: todosNow(c) }),
			});
		return fresh;
	}

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
			if (deps.state) {
				const task = store
					.write((tx) => deps.state!.revokeInTransaction(tx, c.id))
					.then(() => {
						if (convs.get(c.id) === c) {
							c.epoch = store.read((tx) =>
								deps.state!.epochInTransaction(tx, c.id),
							);
							trackSave(c);
						}
					});
				inflight.add(task);
				task.finally(() => inflight.delete(task));
			}
			pending.delete(c.id);
			return;
		}
		// Our own utterances reach the ledger through their receipt.
		if (event.sourceId.startsWith("agency:")) return;
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
		if (deps.state) {
			for (const c of convs.values())
				if (
					store.read((db) => deps.state!.epochInTransaction(db, c.id)) !==
					c.epoch
				)
					dropConv(c, "source_forgotten");
			collectReturns();
		}
		const before = cursor;
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
			if (state.turnEnd && c && conversationId === activeId) {
				workChanged.delete(conversationId);
				newWork(c);
				launch(c, "turn_end");
			}
		}
		// A question is asked where the user is talking; elsewhere it waits for the next turn there.
		for (const conversationId of workChanged) {
			if (conversationId !== activeId) continue;
			const c = convOf(conversationId);
			if (newWork(c)) launch(c, "result_received");
		}
		workChanged.clear();
		prune();
		if (cursor !== before) for (const c of convs.values()) trackSave(c);
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
		const settings = deps.settings.get();
		const next = settings.agency;
		const nextPersona = settings.general;
		if (sameSettings(cfg, next) && samePersona(persona, nextPersona)) return;
		cfg = next;
		persona = nextPersona;
		// Applied immediately: whatever was in flight belongs to the old setting.
		for (const c of convs.values()) {
			c.generation++;
			abortBackground(c);
			c.runtime.invalidate("settings.changed", nowMs());
			const snapshot = c.runtime.snapshot();
			c.scope = newScope();
			c.runtime = newRuntime(c, {
				...snapshot,
				continuity: { ...snapshot.continuity!, issued: [] },
			});
			c.planner = newPlanner(c.id);
			c.scheduler.dispose();
			c.scheduler = newScheduler(c);
			c.scheduler.rearm();
			trackSave(c);
		}
		log.info("agency.settings_applied", {});
	}

	// ---- public ---------------------------------------------------------------

	const dialoguePort: AgencyLayerPort = {
		stateForContextInTransaction(db, id) {
			return projectionLines(deps, convs, db, id);
		},
		workChangedInTransaction(_db, conversationId) {
			workChanged.add(conversationId);
		},
	};

	/**
	 * The conversation agent's replies: its system text (fixed by the settings; its changing state goes in the
	 * context's `now.agency`, so the cached prefix holds) and one reply on the host's model call and tools.
	 */
	const conversationAgent: ConversationAgentPort = {
		system: () => agencyReplyParts(cfg),
		async respond(input) {
			const reply = await runRespond({ ...input, emotion: cfg.emotion });
			return {
				text: reply.text,
				ended: reply.ended,
				...(reply.emotion
					? { emotion: deliveryEmotionOf(emotionName(reply.emotion)) }
					: {}),
			};
		},
	};

	return {
		/** Reads the settings, subscribes to commits and settings changes. The feed starts at its end. */
		start() {
			if (started || closed) return;
			started = true;
			cfg = deps.settings.get().agency;
			const feed = deps.state
				? store.read((db) => deps.state!.feedInTransaction(db))
				: null;
			cursor = feed?.cursor ?? feedEnd();
			activeId = feed?.activeId ?? null;
			if (deps.state)
				for (const record of store.read((db) =>
					deps.state!.recordsInTransaction(db),
				))
					restored.set(record.conversationId, record);
			for (const id of restored.keys()) {
				const c = convOf(id);
				const task = recoverTickets(deps, c, nowMs())
					.then(() => save(c))
					.then(() => c.scheduler.rearm());
				inflight.add(task);
				task.finally(() => inflight.delete(task));
			}
			safePump();
			stoppers.push(deps.settings.onChange(applySettings));
			stoppers.push(store.onCommit(safePump));
		},
		async close() {
			if (closed) return;
			await Promise.all([...convs.values()].map((c) => save(c)));
			closed = true;
			for (const stop of stoppers.splice(0)) stop();
			resetAll("closed");
			await Promise.allSettled(inflight);
		},
		dialoguePort,
		conversationAgent,
		/** The open TODOs of the dialogue ledger (attached once the dialogue service exists). */
		attachWork(value: AgencyWork) {
			work = value;
		},
		forgetInTransaction(
			db: Database,
			purge: { messageIds: readonly string[]; itemIds: readonly string[] },
		) {
			topicsCache = null;
			deps.state?.forgetInTransaction(db, purge);
		},
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
						idle: c.planner.status(),
					}
				: null;
		},
	};
}
