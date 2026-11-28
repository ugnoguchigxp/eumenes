import type { Database } from "bun:sqlite";
import { type AgencyRecord, isAgendaSnapshot } from "../../domains/dialogue";
import type { AgencyActivity } from "../../domains/dialogue/contracts/agency-status";
import { toErrorCode } from "../../infrastructure/error-code";
import { getLogger } from "../../infrastructure/logger";
import type { createAgencyActivity } from "./always-on-activity";
import { mayStep } from "./always-on-cycle";
import { feedAgenda, pumpAgendaHost } from "./always-on-feed";
import {
	keepNote,
	logChipLinkFailure,
	logNoteDisplayFailure,
} from "./always-on-flow";
import type { createAgendaHearing } from "./always-on-heard";
import { recallConversation } from "./always-on-recovery";
import { keepPosition } from "./always-on-position";
import { withheldIds } from "./always-on-recall";
import { scheduleRecords } from "./always-on-records";
import {
	type AgendaScope,
	agendaEnvelope,
	createAgendaScope,
	positionOf,
} from "./always-on-scope";
import type { createGoalAgenda } from "./goal-agenda";
import type { AgencyHostDeps } from "./host-types";
import { workVersionInTransaction } from "./work-observation";

const log = getLogger("agency");

export type GoalAgenda = ReturnType<typeof createGoalAgenda>;
export type GoalStepRef = {
	scope: AgendaScope;
	controller: AbortController;
} | null;
export type PrepareDisplay = (
	scope: AgendaScope,
	note: AgendaScope["notes"][number],
	runId: string,
) => Promise<(db: Database) => void>;

export interface AgendaHostState {
	started: boolean;
	closed: boolean;
	cursor: number;
	savedCursor: number;
	activeId: string | null;
	goalStep: GoalStepRef;
	display: { id: string; until: number } | null;
}

export function readUserMessageText(deps: AgencyHostDeps, messageId: string) {
	return deps.store.read((db) => {
		const source = deps.conversation.sourceInTransaction(db, messageId);
		return source.state === "available" &&
			source.message.role === "user" &&
			withheldIds(deps, db, [messageId]).size === 0
			? source.message.text
			: null;
	});
}

export function createAgendaScopeStore(ctx: {
	deps: AgencyHostDeps;
	convs: Map<string, AgendaScope>;
	persisted: Map<string, number>;
	recovering: Set<string>;
	now(): number;
	track<T>(p: Promise<T>): Promise<T>;
	kick(scope: AgendaScope): void;
	/** The pump runs (what the records writer kept is saved). */
	changed(): void;
	/** Saves a scope's checkpoint inside the caller's transaction (the records writer's position goes with its writes). */
	saveScope(db: Database, c: AgendaScope): void;
}) {
	/** The records writer's pass of a scope: at once when none runs, else right after the one that does. */
	const records = (c: AgendaScope) =>
		scheduleRecords({
			deps: ctx.deps,
			c,
			now: ctx.now,
			changed: ctx.changed,
			track: ctx.track,
			save: ctx.saveScope,
		});
	function make(id: string, previous?: AgencyRecord) {
		const c = createAgendaScope({
			deps: ctx.deps,
			id,
			epoch:
				previous?.epoch ??
				ctx.deps.store.read((db) => ctx.deps.state!.epochInTransaction(db, id)),
			...(previous ? { previous } : {}),
			now: ctx.now,
			text: (messageId) => readUserMessageText(ctx.deps, messageId),
			kick: ctx.kick,
		});
		// The scope joins a conversation that may be under way (a restart is not a new one for the user).
		recallConversation(ctx.deps, c, ctx.now());
		ctx.convs.set(id, c);
		if (previous) {
			ctx.persisted.set(id, c.revision);
			ctx.recovering.add(id);
			// The notes a restart brought back are kept as documents too (one made before is not made again).
			for (const note of c.notes) void ctx.track(keepNote(ctx.deps, c, note));
			records(c);
		}
		return c;
	}
	function conv(id: string) {
		const current = ctx.convs.get(id);
		if (current) return current;
		const record = ctx.deps.store.read((db) =>
			ctx.deps
				.state!.recordsInTransaction(db)
				.find((r) => r.conversationId === id),
		);
		if (record && !isAgendaSnapshot(record.snapshot))
			throw new Error("agency_runtime_not_recovered");
		return make(id, record);
	}
	return { make, conv, records };
}

export async function recoverAgendaRecords(
	deps: AgencyHostDeps,
	goalAgenda: GoalAgenda | undefined,
	hostDigest: string,
) {
	if (!deps.state) return;
	// Nothing to prepare while no goal is registered: the goal host opens with the first reply that may register one.
	if (goalAgenda && goalAgenda.registered() > 0) await goalAgenda.init();
	await deps.store.write((db) => {
		deps.state!.quarantineLegacyInTransaction(db);
		deps.state!.recoverForgottenInTransaction(db);
		for (const r of deps.state!.recordsInTransaction(db)) {
			const agenda = isAgendaSnapshot(r.snapshot);
			if (agenda && r.settingsDigest === hostDigest) continue;
			// A change of the agency's settings is no reason to lose what the user asked toolchains for: their requests
			// (items, tickets, running works) stay in the record under the new digest.
			if (
				agenda &&
				deps.state!.carryAssignmentsInTransaction(
					db,
					r.conversationId,
					hostDigest,
				)
			)
				continue;
			// What the agency remembers goes; where reading the conversation stopped stays.
			keepPosition(deps, r.conversationId, positionOf(r));
			deps.state!.revokeInTransaction(db, r.conversationId);
		}
	});
}

export function drainConversationOutbox(ctx: {
	deps: AgencyHostDeps;
	state: AgendaHostState;
	now(): number;
	hearing: ReturnType<typeof createAgendaHearing>;
	goalAgenda: GoalAgenda | undefined;
	prepareDisplay: PrepareDisplay;
	conv(id: string): AgendaScope;
	forgetRefs(scope: AgendaScope, refs: readonly string[]): void;
	track<T>(p: Promise<T>): Promise<T>;
	schedule(): void;
	setTimer(fn: () => void, ms: number): unknown;
	clearTimer(id: unknown): void;
	records(scope: AgendaScope): void;
}) {
	for (;;) {
		const events = ctx.deps.store.read((db) =>
			ctx.deps.conversation.changesInTransaction(db, ctx.state.cursor, 200),
		);
		for (const event of events) {
			if (
				event.namespace === "conversation" &&
				event.sourceKind === "message"
			) {
				const c = ctx.conv(event.conversationId);
				feedAgenda({
					deps: ctx.deps,
					c,
					event,
					at: ctx.now(),
					hearing: ctx.hearing,
					forget: (scope, refs) => ctx.forgetRefs(scope, refs),
					exchanged: (scope) => ctx.records(scope),
					linked: (scope, messageId, workRefs) =>
						void ctx.track(
							ctx.deps.store
								.write((db) =>
									ctx.deps.state?.linkFindingsInTransaction(
										db,
										scope.id,
										messageId,
										workRefs,
									),
								)
								.catch((error) => logChipLinkFailure(scope.id, error)),
						),
					show: (scope, noteIds, runId) => {
						for (const id of noteIds) {
							const note =
								scope.notes.find((n) => n.id === id) ??
								ctx.goalAgenda?.noteForDisplay(id);
							if (note)
								void ctx.track(
									ctx
										.prepareDisplay(scope, note, runId)
										.then((publish) => ctx.deps.store.write(publish))
										.catch((error) => logNoteDisplayFailure(scope.id, error)),
								);
						}
					},
				});
				if (event.speaker === "user") {
					ctx.goalAgenda?.changed();
					if (ctx.state.goalStep?.scope === c)
						ctx.state.goalStep.controller.abort();
					if (!ctx.state.display || ctx.state.display.until <= ctx.now())
						ctx.state.activeId = c.id;
				}
			}
			ctx.state.cursor = event.seq;
		}
		if (events.length < 200) break;
	}
}

export async function runGoalStepIfDue(
	ctx: {
		state: AgendaHostState;
		goalAgenda: GoalAgenda | undefined;
		on(): boolean;
		busy(c: AgendaScope): boolean;
		now(): number;
	},
	c: AgendaScope,
) {
	const at = ctx.goalAgenda?.nextAt();
	if (
		!ctx.goalAgenda ||
		ctx.state.goalStep ||
		c.stepping ||
		c.id !== ctx.state.activeId ||
		!ctx.on() ||
		ctx.busy(c) ||
		at == null ||
		at > ctx.now()
	)
		return;
	const controller = new AbortController();
	ctx.state.goalStep = { scope: c, controller };
	try {
		await ctx.goalAgenda.tick(controller.signal);
	} catch (error) {
		c.backoffUntil = ctx.now() + 10_000;
		log.warn("agency.goal_step_failed", {
			reason: toErrorCode(error, "goal_step_failed"),
		});
	} finally {
		ctx.state.goalStep = null;
	}
}

export function disposeAgendaScope(
	hearing: ReturnType<typeof createAgendaHearing>,
	clearTimer: (id: unknown) => void,
	c: AgendaScope,
) {
	hearing.dispose(c);
	c.closed.abort();
	if (c.timer !== undefined) clearTimer(c.timer);
	c.timer = undefined;
}

export function invalidateAgendaScope(
	state: AgendaHostState,
	idleWaiters: Set<() => void>,
	c: AgendaScope,
) {
	c.generation++;
	c.controller?.abort();
	if (state.goalStep?.scope === c) state.goalStep.controller.abort();
	c.revision++;
	for (const look of idleWaiters) look();
}

export function syncAgendaBusy(ctx: {
	state: AgendaHostState;
	convs: Map<string, AgendaScope>;
	recovering: Set<string>;
	hearing: ReturnType<typeof createAgendaHearing>;
	idleWaiters: Set<() => void>;
	on(): boolean;
	busy(c: AgendaScope): boolean;
	arm(c: AgendaScope): void;
	schedule(): void;
	/** Starts the records writer's pass (the main conversation is free again after it called one off). */
	records(c: AgendaScope): void;
	foreground(): boolean;
}) {
	if (
		ctx.state.goalStep &&
		(ctx.state.goalStep.scope.id !== ctx.state.activeId ||
			ctx.busy(ctx.state.goalStep.scope))
	)
		ctx.state.goalStep.controller.abort();
	// A reading that ended: its words are said now, before anything is planned.
	let heard = false;
	for (const c of ctx.convs.values()) heard = ctx.hearing.check(c) || heard;
	for (const c of ctx.convs.values()) {
		c.busy =
			ctx.busy(c) ||
			c.id !== ctx.state.activeId ||
			!ctx.on() ||
			ctx.recovering.has(c.id);
		ctx.arm(c);
		if (c.recordsOwed && !c.recordsRun && !ctx.foreground()) ctx.records(c);
	}
	for (const look of ctx.idleWaiters) look();
	// What was said is saved, and the plan of it is due.
	if (heard) ctx.schedule();
}

export function armAgendaScope(
	ctx: {
		state: AgendaHostState;
		cycleHost: Parameters<typeof mayStep>[0];
		busy(c: AgendaScope): boolean;
		goalAgenda: GoalAgenda | undefined;
		now(): number;
		setTimer(fn: () => void, ms: number): unknown;
		clearTimer(id: unknown): void;
		kick(c: AgendaScope): void;
	},
	c: AgendaScope,
) {
	if (c.timer !== undefined) ctx.clearTimer(c.timer);
	c.timer = undefined;
	if (ctx.state.closed || c.stepping || !mayStep(ctx.cycleHost, c)) return;
	const isBusy = ctx.busy(c);
	const goalAt =
		!isBusy && !ctx.state.goalStep && ctx.state.activeId === c.id
			? ctx.goalAgenda?.nextAt()
			: null;
	const next = isBusy
		? ctx.now()
		: Math.min(c.agent.nextAt(ctx.now()) ?? Infinity, goalAt ?? Infinity);
	if (!Number.isFinite(next)) return;
	const at = Math.max(next, c.backoffUntil);
	c.timer = ctx.setTimer(
		() => {
			c.timer = undefined;
			ctx.kick(c);
		},
		Math.max(0, at - ctx.now()),
	);
}

export function createAgendaPumpScheduler(ctx: {
	deps: AgencyHostDeps;
	state: AgendaHostState;
	convs: Map<string, AgendaScope>;
	persisted: Map<string, number>;
	recovering: Set<string>;
	on(): boolean;
	now(): number;
	refresh(c: AgendaScope): Promise<void>;
	invalidate(c: AgendaScope): void;
	feedEvents(): void;
	collect(): Promise<void>;
	syncBusy(): void;
	dispose(c: AgendaScope): void;
	save(opts: { refreshed: boolean }): Promise<unknown>;
	track<T>(p: Promise<T>): Promise<T>;
}) {
	let pumping: Promise<void> | null = null;
	let requested = false;
	/** What the database held for each conversation when the last pump began (see `commitDue`). */
	const observed = new Map<string, string>();
	/** What the conversation's registered goals show (their progress, question and report): a change is news to it. */
	const goalSignature = (db: Database, c: AgendaScope) =>
		JSON.stringify(
			(ctx.deps.goalWork?.viewsInTransaction(db) ?? [])
				.filter(({ conversationId }) => conversationId === c.id)
				.map((view) => [
					view.goalId,
					view.revision,
					view.progress,
					view.question?.ref ?? null,
					view.report?.id ?? null,
				]),
		);
	const dbSignature = (
		db: Database,
		c: AgendaScope,
		work = workVersionInTransaction(ctx.deps, db, c),
	) =>
		[
			ctx.deps.state!.epochInTransaction(db, c.id),
			ctx.deps.conversationBusy(db, c.id),
			!!ctx.deps.backgroundPaused?.(db, c.id),
			work,
			goalSignature(db, c),
		].join(":");
	/** A goal question the goals' own quiet holds back is taken up when that quiet ends, with no commit to wake it. */
	let quietTimer: ReturnType<typeof setTimeout> | undefined;
	const armGoalQuiet = () => {
		const work = ctx.deps.goalWork;
		if (!work) return;
		let until: number | null;
		try {
			until = ctx.deps.store.read((db) => work.heldUntilInTransaction(db));
		} catch {
			return;
		}
		if (quietTimer) clearTimeout(quietTimer);
		quietTimer = undefined;
		if (until === null) return;
		quietTimer = setTimeout(
			() => {
				quietTimer = undefined;
				schedule();
			},
			Math.max(1_000, until - ctx.now()),
		);
		(quietTimer as { unref?: () => void }).unref?.();
	};
	/**
	 * Whether a commit the host did not make itself may change what a pump does. A pump acts on: the outbox past the
	 * cursor, the results of the work ledger, a conversation whose epoch moved (a forget or a revoke), a
	 * conversation that is, or stopped being, busy or paused (the step waits for that), the scopes recovered after a
	 * restart, and what it owes the checkpoint. Everything else (inference attempts, usage, queue polling) is no
	 * reason to run the whole of it.
	 */
	function commitDue() {
		if (ctx.recovering.size) return true;
		if (
			!pumping &&
			(ctx.state.cursor !== ctx.state.savedCursor ||
				[...ctx.convs.values()].some(
					(c) => ctx.persisted.get(c.id) !== c.revision,
				))
		)
			return true;
		try {
			return ctx.deps.store.read(
				(db) =>
					ctx.deps.conversation.outboxHeadInTransaction(db) >
						ctx.state.cursor ||
					ctx.deps.state!.resultsInTransaction(db).length > 0 ||
					[...ctx.convs.values()].some(
						(c) =>
							c.epoch !== ctx.deps.state!.epochInTransaction(db, c.id) ||
							observed.get(c.id) !== dbSignature(db, c),
					),
			);
		} catch {
			// A read that fails says nothing: the pump itself reports what is wrong.
			return true;
		}
	}
	const pump = () => {
		try {
			ctx.deps.store.read((db) => {
				for (const c of ctx.convs.values()) {
					const version = workVersionInTransaction(ctx.deps, db, c);
					observed.set(c.id, dbSignature(db, c, version));
					if (c.workVersion !== undefined && c.workVersion !== version)
						c.agent.infoChanged(ctx.now());
					c.workVersion = version;
				}
			});
		} catch {
			observed.clear();
		}
		return pumpAgendaHost({
			deps: ctx.deps,
			convs: ctx.convs,
			persisted: ctx.persisted,
			recovering: ctx.recovering,
			on: ctx.on,
			now: ctx.now,
			refresh: ctx.refresh,
			invalidate: ctx.invalidate,
			feedEvents: ctx.feedEvents,
			collect: ctx.collect,
			syncBusy: ctx.syncBusy,
			dispose: ctx.dispose,
			async save() {
				if (
					ctx.state.cursor !== ctx.state.savedCursor ||
					[...ctx.convs.values()].some(
						(c) => ctx.persisted.get(c.id) !== c.revision,
					)
				)
					await ctx.save({ refreshed: true });
			},
		});
	};
	function schedule() {
		requested = true;
		if (pumping || !ctx.on()) return;
		pumping = ctx.track(
			(async () => {
				while (requested && ctx.on()) {
					requested = false;
					await pump();
				}
			})()
				.catch((error) =>
					log.warn("agency.feed_failed", {
						reason: toErrorCode(error, "feed_failed"),
					}),
				)
				.finally(() => {
					pumping = null;
					if (requested && ctx.on()) schedule();
					else if (ctx.on()) armGoalQuiet();
				}),
		);
	}
	return {
		schedule,
		/** The commit listener: a pump only when the commit may matter to it. */
		onCommit() {
			if (commitDue()) schedule();
		},
	};
}

export function startAgendaHost(ctx: {
	deps: AgencyHostDeps;
	state: AgendaHostState;
	make(id: string, previous?: AgencyRecord): AgendaScope;
	stoppers: Array<() => void>;
	schedule(): void;
	/** A database commit: schedules a pump when it may matter (see `createAgendaPumpScheduler`). */
	onCommit(): void;
	syncBusy(): void;
}) {
	if (ctx.state.started || ctx.state.closed) return;
	ctx.state.started = true;
	if (!ctx.deps.state) return;
	const feed = ctx.deps.store.read((db) =>
		ctx.deps.state!.feedInTransaction(db),
	);
	ctx.state.cursor =
		feed?.cursor ??
		ctx.deps.store.read((db) =>
			ctx.deps.conversation.outboxHeadInTransaction(db),
		);
	ctx.state.savedCursor = ctx.state.cursor;
	ctx.state.activeId = feed?.activeId ?? null;
	for (const r of ctx.deps.store.read((db) =>
		ctx.deps.state!.recordsInTransaction(db),
	))
		if (isAgendaSnapshot(r.snapshot)) ctx.make(r.conversationId, r);
	ctx.stoppers.push(ctx.deps.store.onCommit(ctx.onCommit));
	if (ctx.deps.inference.onActivity)
		ctx.stoppers.push(ctx.deps.inference.onActivity(ctx.syncBusy));
	ctx.schedule();
}

export async function closeAgendaHost(ctx: {
	deps: AgencyHostDeps;
	state: AgendaHostState;
	stoppers: Array<() => void>;
	activity: ReturnType<typeof createAgencyActivity>;
	idleWaiters: Set<() => void>;
	convs: Map<string, AgendaScope>;
	hearing: ReturnType<typeof createAgendaHearing>;
	now(): number;
	invalidate(c: AgendaScope): void;
	dispose(c: AgendaScope): void;
	inflight: Set<Promise<unknown>>;
	goalAgenda: GoalAgenda | undefined;
	save(): Promise<unknown>;
}) {
	if (ctx.state.closed) return;
	ctx.state.closed = true;
	ctx.state.goalStep?.controller.abort();
	for (const stop of ctx.stoppers.splice(0)) stop();
	ctx.activity.close();
	for (const look of ctx.idleWaiters) look();
	for (const c of ctx.convs.values()) {
		// What was being read is said: the checkpoint does not owe it again.
		ctx.hearing.flush(c, ctx.now());
		ctx.invalidate(c);
		ctx.dispose(c);
	}
	await Promise.allSettled(ctx.inflight);
	await ctx.goalAgenda?.close();
	if (ctx.deps.state && ctx.deps.memory.referenceInputs) await ctx.save();
}

export async function attendAgendaScope<T>(
	ctx: {
		state: AgendaHostState;
		on(): boolean;
		activity: ReturnType<typeof createAgencyActivity>;
		conv(id: string): AgendaScope;
		now(): number;
		syncBusy(): void;
		save(): Promise<unknown>;
		status(id: string): T;
	},
	id: string,
	report?: AgencyActivity,
) {
	if (!ctx.on()) throw new Error("agency_unavailable");
	if (
		report &&
		(!ctx.activity.update(id, report) || !report.visible || report.leaving)
	)
		return ctx.status(id);
	const entering = ctx.state.activeId !== id;
	const c = ctx.conv(id);
	ctx.state.activeId = id;
	ctx.state.display = { id, until: ctx.now() + 45_000 };
	if (entering) c.revision++;
	ctx.syncBusy();
	if (entering) await ctx.save();
	return ctx.status(id);
}

/** What the agent of a conversation holds now, for a look from outside (null: it has no scope). */
export function inspectScope(
	c: AgendaScope | undefined,
	now: () => number,
	status: (id: string) => { idle: unknown },
) {
	return c
		? {
				snapshot: agendaEnvelope(c, now()),
				generation: c.generation,
				idle: status(c.id).idle,
			}
		: null;
}

/** Waits until the user is free again (false: the scope or the host is gone). The user's words end the wait early. */
export function waitForIdle(
	ctx: {
		state: AgendaHostState;
		convs: Map<string, AgendaScope>;
		on(): boolean;
		busy(c: AgendaScope): boolean;
		idleWaiters: Set<() => void>;
	},
	c: AgendaScope,
) {
	// The user's words (or a forget) make the held line stale: the wait ends, and the retry drops it.
	const generation = c.generation;
	return new Promise<boolean>((resolve) => {
		const look = () => {
			const gone = ctx.state.closed || ctx.convs.get(c.id) !== c || !ctx.on();
			if (!gone && c.generation === generation && ctx.busy(c)) return;
			ctx.idleWaiters.delete(look);
			resolve(!gone);
		};
		ctx.idleWaiters.add(look);
		look();
	});
}
