import { archiveOf, resultInput } from "./memory";
import { currentInput, staleInputSources } from "./input";
import type { Database } from "bun:sqlite";
import type { AgencySnapshot, IdleCheckpoint } from "eumenes-agency";
import {
	createIdleScheduler,
	prepareForgetting,
	prepareCompaction,
	HOST_RULES_VERSION,
	INSTRUCTION_VERSION,
	emotionName,
	runRespond,
	type AgencyRuntime,
	type CycleOutcome,
	type IdlePlanner,
	type LlmPort,
	type LlmRequest,
	type Opportunity,
} from "eumenes-agency";
import type { AgencyRecord } from "../../domains/dialogue";
import type {
	AgencyLayerPort,
	ConversationAgentPort,
} from "../../domains/dialogue/contracts";
import { toErrorCode } from "../../infrastructure/error-code";
import { getLogger } from "../../infrastructure/logger";
import { createCheckpoint } from "./checkpoint";
import { createConversationLifecycle } from "./conversation-lifecycle";
import { createAgencyDelivery } from "./delivery";
import { logCalls, logDecision } from "./diagnostics";
import { createAgencyFeed } from "./feed";
import type {
	AgencyHostDeps,
	AgencySettings,
	Conv,
	Cycle,
	HostPersona,
} from "./host-types";
import { hostPlanner, recoverTickets } from "./recovery";
import {
	projectionContext,
	researchTools,
	waitingForWork,
	snapshotRefs,
} from "./research";
import { createResultCollector } from "./returns";
import { createHostRuntime } from "./runtime";
import { deliveryEmotionOf } from "./speech";
import { agencyReplyParts } from "./system-context";
import { selectMemoryTopics } from "./topics";
import type { AgencyWork } from "./work";
import { captureHostInput } from "./input";
export type { AgencyHostDeps, AgencySettings } from "./host-types";

const samePersona = (a: HostPersona, b: HostPersona) =>
	a.agentName === b.agentName &&
	a.userName === b.userName &&
	a.persona === b.persona;

/** Topics are re-read from memory at most this often. */
const TOPICS_TTL_MS = 30_000;

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
	const digest = () =>
		JSON.stringify({
			agency: cfg,
			persona,
			HOST_RULES_VERSION,
			INSTRUCTION_VERSION,
		});
	const checkpoint = createCheckpoint({
		deps,
		inflight,
		convs,
		nowMs,
		digest,
		feed: () => ({ cursor, activeId }),
	});
	const save = checkpoint.save;

	const state = {
		get activeId() {
			return activeId;
		},
		set activeId(value: string | null) {
			activeId = value;
		},
		get cursor() {
			return cursor;
		},
		set cursor(value: number) {
			cursor = value;
		},
	};
	const {
		convOf,
		abortBackground,
		invalidate,
		activate,
		dropConv,
		resetAll,
		prune,
	} = createConversationLifecycle({
		deps,
		inflight,
		convs,
		restored,
		state,
		nowMs,
		newScope,
		newRuntime,
		newPlanner: (id, restore) => newPlanner(id, restore),
		newScheduler,
		armReview,
		clearTimer,
		digest,
		clearTopics: () => {
			topicsCache = null;
		},
	});
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
					? selectMemoryTopics(memory.list(), now, (item) =>
							deps.memory.referenceInputs
								? store.read((db) =>
										deps.memory.referenceInputs!.captureInTransaction(db, {
											itemIds: [item.id],
											itemRevisions: { [item.id]: item.revision },
										}),
									)
								: { sources: [`memory:${item.id}`], complete: false },
						)
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
			...(c.preparedContext
				? {
						messages: c.preparedContext.map((message, index, messages) =>
							index === messages.length - 1
								? { ...message, content: message.content + request.prompt }
								: { ...message },
						),
					}
				: {}),
		}));
		return {
			async complete<T>(request: LlmRequest<T>, signal: AbortSignal) {
				try {
					const current = () => {
						const valid = store.read((db) =>
							currentInput(
								deps,
								db,
								request.input ?? { sources: [], complete: false },
							),
						);
						if (!valid)
							throw new DOMException("agency_input_stale", "AbortError");
					};
					current();
					const result = await inner.complete(request, signal);
					current();
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
			now: nowMs,
			agency: cfg,
			persona,
			...(restore ? { restore } : {}),
			tools: researchTools(store, deps.state),
			todos: () => todosNow(c),
			topics: topicsNow,
			llm: wrapLlm(c, newScope()),
			input: () => captureHostInput(deps, c, { agency: cfg, persona }),
			archive: archiveOf(deps, c),
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

	const idleFields = (planner: IdlePlanner) => {
		const status = planner.status();
		return {
			phase: status.blockedBy ?? "armed",
			count: status.unanswered,
			attempt: status.level,
			durationMs: status.nextIntervalSec * 1000,
		};
	};

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
		isCurrent: (cy, db, ticket) => {
			const action = ticket.action;
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
				currentInput(deps, db, resultInput(c, ticket.id)) &&
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
		if (!decision) return "aborted";
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
		if (
			[
				"host_blocked",
				"host_budget",
				"host_stale",
				"host_delegation",
				"host_disabled",
			].includes(decision.source) ||
			(decision.rejectCodes.length === 1 &&
				decision.rejectCodes[0] === "outbound_interval")
		)
			return "aborted";
		if (decision.source === "rejected" || decision.source === "error")
			return "failed";
		if (!decision.ticket) return "silent";
		if (!(await save(c))) return "aborted";
		return deliver(cy, decision.ticket, decision.evidenceRefs);
	}

	async function refreshSources(c: Conv) {
		const stale = store.read((db) =>
			staleInputSources(deps, db, snapshotRefs(c.runtime)),
		);
		if (!stale.length) return;
		applySourceChange(c, stale);
		topicsCache = null;
		if (deps.state)
			await store.write((db) =>
				deps.state!.forgetInTransaction(db, {
					messageIds: [],
					itemIds: [],
					sourceRefs: stale,
				}),
			);
	}

	async function cycle(
		c: Conv,
		trigger: Opportunity["trigger"],
	): Promise<CycleOutcome> {
		if (!on() || convs.get(c.id) !== c) return "halted";
		if (!memory.status().healthy) return "aborted";
		await refreshSources(c);
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
		let outcome: CycleOutcome = "failed";
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
			if (on() && convs.get(c.id) === c) await refreshSources(c);
			if (
				on() &&
				convs.get(c.id) === c &&
				(await save(c)) &&
				deps.memory.referenceInputs &&
				deps.state &&
				!c.background
			) {
				const plan = prepareCompaction(c.runtime.snapshot());
				if (plan.archive.length) {
					const old = c.runtime;
					c.generation++;
					c.runtime = newRuntime(c, plan.checkpoint);
					old.setEnabled(false);
				}
			}
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

	const { safePump, workChanged } = createAgencyFeed({
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
		lifecycle: { convOf, dropConv, invalidate, activate, prune },
		retract(c, sourceId) {
			const input = c.runtime
				.snapshot()
				.provenance?.entries.find(
					([key]) => key === `observation:${sourceId}`,
				)?.[1];
			const refs = deps.memory.referenceInputs?.messageReferences(
				input?.sources ?? [],
				sourceId,
			) ?? [sourceId];
			applySourceChange(c, refs);
			if (c.runtime.snapshot().observations.length === 0) {
				c.scheduler.dispose();
				c.planner = newPlanner(c.id);
				c.scheduler = newScheduler(c);
				c.scheduler.rearm();
			}
			if (!deps.state) return Promise.resolve();
			return store
				.write((db) =>
					deps.state!.forgetInTransaction(db, {
						messageIds: [],
						itemIds: [],
						sourceRefs: refs,
					}),
				)
				.then(() => undefined);
		},
	});
	// ---- feed handling ----------------------------------------------------

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

	/** Replace only the dependent state; independent outstanding tickets retain their identity. */
	function applySourceChange(c: Conv, refs: readonly string[]) {
		const snapshot = prepareForgetting(c.runtime.snapshot(), refs).checkpoint;
		c.generation++;
		abortBackground(c);
		const old = c.runtime;
		c.runtime = newRuntime(c, snapshot);
		old.setEnabled(false);
	}

	// ---- public ---------------------------------------------------------------

	const dialoguePort: AgencyLayerPort = {
		isCurrentInputInTransaction: (db, input) => currentInput(deps, db, input),
		inputForMessageInTransaction: (db, id) =>
			deps.state?.messageInputInTransaction(db, id) ?? null,
		inputForContextInTransaction: (db, id) =>
			projectionContext(deps, convs, db, id).input,
		stateForContextInTransaction: (db, id) =>
			projectionContext(deps, convs, db, id).lines,
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
		/** Complete the legacy fence before the server starts any execution worker. */
		async recover() {
			if (deps.state)
				await store.write((db) =>
					deps.state!.quarantineLegacyInTransaction(db),
				);
		},
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
				const task = refreshSources(c)
					.then(() => recoverTickets(deps, c, nowMs()))
					.then(() => save(c))
					.then(() => {
						if (on() && convs.get(c.id) === c) c.scheduler.rearm();
					})
					.catch((error) => {
						if (convs.get(c.id) === c) dropConv(c, "restore_failed");
						log.warn("agency.restore_failed", {
							reason: toErrorCode(error, "restore_failed"),
						});
					});
				inflight.add(task);
				task.finally(() => inflight.delete(task));
			}
			safePump();
			stoppers.push(deps.settings.onChange(applySettings));
			stoppers.push(store.onCommit(safePump));
		},
		async close() {
			if (closed) return;
			closed = true;
			for (const stop of stoppers.splice(0)) stop();
			for (const c of convs.values()) {
				invalidate(c, "closed");
				c.scheduler.dispose();
			}
			await Promise.all([...convs.values()].map((c) => save(c)));
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
			purge: {
				messageIds: readonly string[];
				itemIds: readonly string[];
				forgetIds?: readonly string[];
			},
		) {
			topicsCache = null;
			const refs = [
				...purge.messageIds,
				...purge.itemIds.map((id) => `memory:${id}`),
			];
			for (const c of convs.values()) applySourceChange(c, refs);
			deps.state?.forgetInTransaction(db, purge);
		},
		planForgetInTransaction(
			db: Database,
			input: { messageIds: readonly string[]; itemIds: readonly string[] },
		) {
			return deps.state?.planForgetInTransaction(db, input) ?? {};
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
