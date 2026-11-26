import type { Database } from "bun:sqlite";
import type {
	AgencyActivity,
	AgencyThought,
} from "../../domains/dialogue/contracts/agency-status";
import { toErrorCode } from "../../infrastructure/error-code";
import { getLogger } from "../../infrastructure/logger";
import { createAgencyActivity } from "./always-on-activity";
import { createAgendaCheckpoints } from "./always-on-checkpoint";
import { collectAgendaResults, runAgendaStep } from "./always-on-cycle";
import { prepareNoteDisplay } from "./always-on-flow";
import { createAgendaHearing } from "./always-on-heard";
import { createAgendaPorts } from "./always-on-ports";
import { createTargetQueue } from "./always-on-target";
import {
	type AgendaHostState,
	armAgendaScope,
	waitForIdle,
	attendAgendaScope,
	closeAgendaHost,
	createAgendaPumpScheduler,
	createAgendaScopeStore,
	disposeAgendaScope,
	inspectScope,
	drainConversationOutbox,
	invalidateAgendaScope,
	recoverAgendaRecords,
	runGoalStepIfDue,
	startAgendaHost,
	syncAgendaBusy,
} from "./always-on-runtime";
import { type AgendaScope, agendaReady } from "./always-on-scope";
import { agendaSettingsKey } from "./always-on-settings";
import { createGoalAgenda } from "./goal-agenda";
import type { AgencyHostDeps } from "./host-types";

const log = getLogger("agency");

/**
 * The always-on runtime: the agenda agent (eumenes-agency/agenda) of each conversation, and what Eumenes runs around
 * it. Host orchestration only: the agent keeps the list of things to do and decides when and which; the host feeds it
 * the conversation, hands its tickets to the toolchains and the speech path, and saves what it owes across a restart.
 */
/** The host's clock and timers: the deps' own (tests), else the real ones. */
function hostTimers(deps: AgencyHostDeps) {
	return {
		now: deps.nowMs ?? Date.now,
		setTimer:
			deps.setTimer ??
			((fn: () => void, ms: number): unknown => setTimeout(fn, ms)),
		clearTimer:
			deps.clearTimer ??
			((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>)),
	};
}

export function createAlwaysOnHost(deps: AgencyHostDeps) {
	const { now, setTimer, clearTimer } = hostTimers(deps);
	const convs = new Map<string, AgendaScope>();
	const persisted = new Map<string, number>();
	const recovering = new Set<string>();
	const stoppers: Array<() => void> = [];
	const inflight = new Set<Promise<unknown>>();
	const state: AgendaHostState = {
		started: false,
		closed: false,
		cursor: 0,
		savedCursor: -1,
		activeId: null,
		goalStep: null,
		display: null,
	};
	const digest = () => agendaSettingsKey(deps.settings.get());
	const hostDigest = digest();
	const activity = createAgencyActivity({
		now,
		changed: () => syncBusy(),
		setTimer,
		clearTimer,
	});
	// When the agent's words count as said: at the end of their reading on a screen of the conversation.
	const hearing = createAgendaHearing({
		now,
		attended: (id) => activity.attended(id),
		playing: (id) => activity.playing(id),
		setTimer,
		clearTimer,
		wake: () => syncBusy(),
		failed: (c, error) =>
			log.warn("agency.heard_failed", {
				subjectId: c.id,
				reason: toErrorCode(error, "heard_failed"),
			}),
	});
	/** Steps that hold a line until the user is free again. */
	const idleWaiters = new Set<() => void>();
	const on = () => state.started && !state.closed && agendaReady(deps);
	const goalAgenda = createGoalAgenda({
		deps,
		now,
		active: () =>
			on() && state.activeId ? convs.get(state.activeId) : undefined,
		scope: (id) => convs.get(id),
		idle: (c) =>
			!recovering.has(c.id) &&
			!busy(c) &&
			!deps.store.read((db) => deps.backgroundPaused?.(db, c.id)),
	});
	const prepareDisplay = prepareNoteDisplay.bind(null, deps, {
		now,
		setTimer,
		clearTimer,
		goalNoteInTransaction: goalAgenda?.displayNoteInTransaction,
	});
	const track = <T>(p: Promise<T>): Promise<T> => {
		inflight.add(p);
		void p.finally(() => inflight.delete(p)).catch(() => {});
		return p;
	};
	const { make, conv, records } = createAgendaScopeStore({
		deps,
		convs,
		persisted,
		recovering,
		now,
		track,
		changed: () => schedule(),
		saveScope: (db, c) => saveScopeInTransaction(db, c),
		kick: (scope) => {
			void kickScope(scope);
		},
	});
	function busy(c: AgendaScope) {
		return (
			// Its last words are still being read aloud.
			c.unheard.length > 0 ||
			activity.busy(c.id) ||
			deps.inference.foregroundBusy() ||
			deps.store.read((db) => deps.conversationBusy(db, c.id))
		);
	}
	const cycleHost = () => ({
		deps,
		convs,
		on,
		now,
		busy,
		digest,
		save: () => save(),
		active: () => state.activeId,
		refresh: (c: AgendaScope) => refresh(c),
		hearing,
		idle,
	});
	const idle = (c: AgendaScope) =>
		waitForIdle({ state, convs, on, busy, idleWaiters }, c);
	const arm = (c: AgendaScope) =>
		armAgendaScope(
			{
				state,
				cycleHost: cycleHost(),
				busy,
				goalAgenda,
				now,
				setTimer,
				clearTimer,
				kick: (scope) => {
					void kickScope(scope);
				},
			},
			c,
		);
	/** One step now (or right after the one running), then the timer for the next. */
	function kickScope(c: AgendaScope) {
		return track(
			runAgendaStep(cycleHost(), c)
				.then(() => runGoalStepIfDue({ state, goalAgenda, on, busy, now }, c))
				.finally(() => {
					if (convs.get(c.id) === c) arm(c);
				}),
		);
	}
	/** The scope of a conversation the agenda serves now (made when it has none). */
	const serving = (id: string) => {
		if (!on()) return undefined;
		try {
			return conv(id);
		} catch {
			return undefined;
		}
	};
	const targets = createTargetQueue({
		deps,
		scope: serving,
		now,
		forget: (c, refs) => forgetRefs(c, refs),
		track,
	});
	const syncBusy = () => {
		targets.drain();
		syncAgendaBusy({
			state,
			convs,
			recovering,
			hearing,
			idleWaiters,
			on,
			busy,
			arm,
			schedule,
			records,
			foreground: () => deps.inference.foregroundBusy(),
		});
	};
	const dispose = (c: AgendaScope) =>
		disposeAgendaScope(hearing, clearTimer, c);
	const invalidate = (c: AgendaScope) =>
		invalidateAgendaScope(state, idleWaiters, c);
	const {
		save,
		saveInTransaction,
		saveScopeInTransaction,
		refresh,
		forgetInTransaction,
		forgetRefs,
		excludeRefs,
	} = createAgendaCheckpoints({
		deps,
		convs,
		now,
		hostDigest,
		invalidate,
		persisted,
		feed: () => ({ cursor: state.cursor, activeId: state.activeId }),
		saved(rows, value) {
			for (const row of rows) persisted.set(row.id, row.revision);
			state.savedCursor = value;
		},
	});
	/** The outbox up to its head, into the agents. Synchronous: the cursor and the agents move together. */
	const feedEvents = () =>
		drainConversationOutbox({
			deps,
			state,
			now,
			hearing,
			goalAgenda,
			prepareDisplay,
			conv,
			forgetRefs,
			track,
			schedule,
			setTimer,
			clearTimer,
			records,
		});
	const collect = () =>
		collectAgendaResults({
			deps,
			convs,
			now,
			conv,
			saveInTransaction,
			collected() {
				for (const c of convs.values()) persisted.set(c.id, c.revision);
				state.savedCursor = state.cursor;
			},
		});
	const { schedule, onCommit } = createAgendaPumpScheduler({
		deps,
		state,
		convs,
		persisted,
		recovering,
		on,
		now,
		refresh,
		invalidate,
		feedEvents,
		collect,
		syncBusy,
		dispose,
		save,
		track,
	});
	const { dialoguePort, conversationAgent, status } = createAgendaPorts({
		deps,
		convs,
		prepareDisplay,
		goalAgenda,
		serving: (id) => serving(id) ?? null,
		active: () => state.activeId,
		display: () => state.display,
		now,
		catchUp: () => {
			if (on()) feedEvents();
		},
		heard: (c) => hearing.flush(c, now()),
		changed: schedule,
		exclude: excludeRefs,
		save: () => save(),
	});
	return {
		recover: () => recoverAgendaRecords(deps, goalAgenda, hostDigest),
		start: () =>
			startAgendaHost({
				deps,
				state,
				make,
				stoppers,
				schedule,
				onCommit,
				syncBusy,
			}),
		close: () =>
			closeAgendaHost({
				deps,
				state,
				stoppers,
				activity,
				idleWaiters,
				convs,
				hearing,
				now,
				invalidate,
				dispose,
				inflight,
				goalAgenda,
				save,
			}),
		dialoguePort,
		conversationAgent,
		/** The resolution of a target named in words (see `always-on-target.ts`); the dialogue domain's port calls it. */
		memoryTargets: targets.port,
		forgetInTransaction,
		planForgetInTransaction: (
			db: Database,
			input: { messageIds: readonly string[]; itemIds: readonly string[] },
		) => deps.state?.planForgetInTransaction(db, input) ?? {},
		invalidateTopics: schedule,
		attend: (id: string, report?: AgencyActivity) =>
			attendAgendaScope(
				{ state, on, activity, conv, now, syncBusy, save, status },
				id,
				report,
			),
		status,
		thoughts: (id: string): AgencyThought[] => [
			...(convs.get(id)?.thoughts ?? []),
		],
		inspect: (id: string) => inspectScope(convs.get(id), now, status),
	};
}
