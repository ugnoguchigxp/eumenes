import type { Database } from "bun:sqlite";
import { createAgendaCheckpoints } from "./always-on-checkpoint";
import {
	collectAgendaResults,
	mayStep,
	runAgendaStep,
} from "./always-on-cycle";
import { createAgendaPorts } from "./always-on-ports";
import { feedAgenda, pumpAgendaHost } from "./always-on-feed";
import { isAgendaSnapshot, type AgencyRecord } from "../../domains/dialogue";
import { getLogger } from "../../infrastructure/logger";
import { toErrorCode } from "../../infrastructure/error-code";
import { fixedInput } from "./input";
import { keepNote, showNote } from "./always-on-flow";
import { writeProfile } from "./always-on-profile";
import {
	createAgendaScope,
	agendaEnvelope,
	agendaReady,
	type AgendaScope,
} from "./always-on-scope";
import type { AgencyHostDeps } from "./host-types";
import type { AgencyWork } from "./work";
import { createAgencyActivity } from "./always-on-activity";
import { createAgendaHearing } from "./always-on-heard";
import { recallConversation } from "./always-on-recovery";
import type { AgencyActivity } from "../../domains/dialogue/contracts/agency-status";

/**
 * The always-on runtime: the agenda agent (eumenes-agency/agenda) of each conversation, and what Eumenes runs around
 * it. Host orchestration only: the agent keeps the list of things to do and decides when and which; the host feeds it
 * the conversation, hands its tickets to the toolchains and the speech path, and saves what it owes across a restart.
 */
export function createAlwaysOnHost(deps: AgencyHostDeps) {
	const now = deps.nowMs ?? Date.now;
	const log = getLogger("agency");
	const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
	const clearTimer =
		deps.clearTimer ??
		((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>));
	const convs = new Map<string, AgendaScope>();
	const persisted = new Map<string, number>();
	const recovering = new Set<string>();
	const stoppers: Array<() => void> = [];
	const inflight = new Set<Promise<unknown>>();
	let started = false,
		closed = false,
		cursor = 0,
		savedCursor = -1;
	let activeId: string | null = null;
	let display: { id: string; until: number } | null = null;
	let pumping: Promise<void> | null = null;
	let requested = false;
	const settings = () => {
		const s = deps.settings.get();
		return { agency: s.agency, general: s.general };
	};
	const digest = () => fixedInput(settings()).sources[0]!;
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
	const on = () => started && !closed && agendaReady(deps);
	const track = <T>(p: Promise<T>): Promise<T> => {
		inflight.add(p);
		void p.finally(() => inflight.delete(p)).catch(() => {});
		return p;
	};
	const text = (messageId: string) =>
		deps.store.read((db) => {
			const source = deps.conversation.sourceInTransaction(db, messageId);
			return source.state === "available" &&
				source.message.role === "user" &&
				!deps.memory.isBlockedInTransaction?.(db, messageId)
				? source.message.text
				: null;
		});
	function make(id: string, previous?: AgencyRecord) {
		const c = createAgendaScope({
			deps,
			id,
			epoch:
				previous?.epoch ??
				deps.store.read((db) => deps.state!.epochInTransaction(db, id)),
			...(previous ? { previous } : {}),
			now,
			text,
			kick: (scope) => {
				void kickScope(scope);
			},
		});
		// The scope joins a conversation that may be under way (a restart is not a new one for the user).
		recallConversation(deps, c, now());
		convs.set(id, c);
		if (previous) {
			persisted.set(id, c.revision);
			recovering.add(id);
			// The notes a restart brought back are kept as documents too (one made before is not made again).
			for (const note of c.notes) void track(keepNote(deps, c, note));
		}
		return c;
	}
	function conv(id: string) {
		const current = convs.get(id);
		if (current) return current;
		const record = deps.store.read((db) =>
			deps.state!.recordsInTransaction(db).find((r) => r.conversationId === id),
		);
		if (record && !isAgendaSnapshot(record.snapshot))
			throw new Error("agency_runtime_not_recovered");
		return make(id, record);
	}
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
		active: () => activeId,
		refresh: (c: AgendaScope) => refresh(c),
		hearing,
		idle,
	});
	function idle(c: AgendaScope) {
		// The user's words (or a forget) make the held line stale: the wait ends, and the retry drops it.
		const generation = c.generation;
		return new Promise<boolean>((resolve) => {
			const look = () => {
				const gone = closed || convs.get(c.id) !== c || !on();
				if (!gone && c.generation === generation && busy(c)) return;
				idleWaiters.delete(look);
				resolve(!gone);
			};
			idleWaiters.add(look);
			look();
		});
	}
	/**
	 * The timer of the agent's next step: none while the user is elsewhere; while the user is typing or answered,
	 * only for research that waits to start (at once).
	 */
	function arm(c: AgendaScope) {
		if (c.timer !== undefined) clearTimer(c.timer);
		c.timer = undefined;
		if (closed || c.stepping || !mayStep(cycleHost(), c)) return;
		const next = busy(c) ? now() : c.agent.nextAt(now());
		if (next === null) return;
		const at = Math.max(next, c.backoffUntil);
		c.timer = setTimer(
			() => {
				c.timer = undefined;
				void kickScope(c);
			},
			Math.max(0, at - now()),
		);
	}
	/** One step now (or right after the one running), then the timer for the next. */
	function kickScope(c: AgendaScope) {
		return track(
			runAgendaStep(cycleHost(), c).finally(() => {
				if (convs.get(c.id) === c) arm(c);
			}),
		);
	}
	function syncBusy() {
		// A reading that ended: its words are said now, before anything is planned.
		let heard = false;
		for (const c of convs.values()) heard = hearing.check(c) || heard;
		for (const c of convs.values()) {
			c.busy = busy(c) || c.id !== activeId || !on() || recovering.has(c.id);
			arm(c);
		}
		for (const look of idleWaiters) look();
		// What was said is saved, and the plan of it is due.
		if (heard) schedule();
	}
	function dispose(c: AgendaScope) {
		hearing.dispose(c);
		c.profileAbort.abort();
		if (c.timer !== undefined) clearTimer(c.timer);
		c.timer = undefined;
	}
	function invalidate(c: AgendaScope) {
		c.generation++;
		c.controller?.abort();
		c.revision++;
		for (const look of idleWaiters) look();
	}
	const { save, saveInTransaction, refresh, forgetInTransaction, forgetRefs } =
		createAgendaCheckpoints({
			deps,
			convs,
			now,
			hostDigest,
			invalidate,
			feed: () => ({ cursor, activeId }),
			saved(rows, value) {
				for (const row of rows) persisted.set(row.id, row.revision);
				savedCursor = value;
			},
		});
	/** The outbox up to its head, into the agents. Synchronous: the cursor and the agents move together. */
	function feedEvents() {
		for (;;) {
			const events = deps.store.read((db) =>
				deps.conversation.changesInTransaction(db, cursor, 200),
			);
			for (const event of events) {
				if (
					event.namespace === "conversation" &&
					event.sourceKind === "message"
				) {
					const c = conv(event.conversationId);
					feedAgenda({
						deps,
						c,
						event,
						at: now(),
						hearing,
						forget: (scope, refs) => forgetRefs(scope, refs),
						exchanged: (scope) => {
							void track(
								writeProfile({
									deps,
									c: scope,
									now,
									changed: () => {
										requested = true;
										schedule();
									},
								}),
							);
						},
						show: (scope, noteIds, runId) => {
							for (const id of noteIds) {
								const note = scope.notes.find((n) => n.id === id);
								if (note)
									void track(
										showNote(deps, scope, note, runId, {
											now,
											setTimer,
											clearTimer,
										}).catch((error) =>
											log.warn("agency.show_note_failed", {
												subjectId: scope.id,
												reason: toErrorCode(error, "show_note_failed"),
											}),
										),
									);
							}
						},
					});
					if (event.speaker === "user" && (!display || display.until <= now()))
						activeId = c.id;
				}
				cursor = event.seq;
			}
			if (events.length < 200) break;
		}
	}
	const collect = () =>
		collectAgendaResults({
			deps,
			convs,
			now,
			conv,
			saveInTransaction,
			collected() {
				for (const c of convs.values()) persisted.set(c.id, c.revision);
				savedCursor = cursor;
			},
		});
	const { dialoguePort, conversationAgent, status } = createAgendaPorts({
		deps,
		convs,
		serving: (id) => {
			if (!on()) return null;
			try {
				return conv(id);
			} catch {
				return null;
			}
		},
		active: () => activeId,
		display: () => display,
		now,
		catchUp: () => {
			if (on()) feedEvents();
		},
		heard: (c) => hearing.flush(c, now()),
		changed: () => {
			requested = true;
			schedule();
		},
	});
	const pump = () =>
		pumpAgendaHost({
			deps,
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
			async save() {
				if (
					cursor !== savedCursor ||
					[...convs.values()].some((c) => persisted.get(c.id) !== c.revision)
				)
					await save();
			},
		});
	function schedule() {
		requested = true;
		if (pumping || !on()) return;
		pumping = track(
			(async () => {
				while (requested && on()) {
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
					if (requested && on()) schedule();
				}),
		);
	}
	return {
		async recover() {
			if (!deps.state) return;
			await deps.store.write((db) => {
				deps.state!.quarantineLegacyInTransaction(db);
				deps.state!.recoverForgottenInTransaction(db);
				for (const r of deps.state!.recordsInTransaction(db))
					if (!isAgendaSnapshot(r.snapshot) || r.settingsDigest !== hostDigest)
						deps.state!.revokeInTransaction(db, r.conversationId);
			});
		},
		start() {
			if (started || closed) return;
			started = true;
			if (!deps.state) return;
			const feed = deps.store.read((db) => deps.state!.feedInTransaction(db));
			cursor =
				feed?.cursor ??
				deps.store.read((db) => deps.conversation.outboxHeadInTransaction(db));
			savedCursor = cursor;
			activeId = feed?.activeId ?? null;
			for (const r of deps.store.read((db) =>
				deps.state!.recordsInTransaction(db),
			))
				if (isAgendaSnapshot(r.snapshot)) make(r.conversationId, r);
			stoppers.push(deps.store.onCommit(schedule));
			if (deps.inference.onActivity)
				stoppers.push(deps.inference.onActivity(syncBusy));
			schedule();
		},
		async close() {
			if (closed) return;
			closed = true;
			for (const stop of stoppers.splice(0)) stop();
			activity.close();
			for (const look of idleWaiters) look();
			for (const c of convs.values()) {
				// What was being read is said: the checkpoint does not owe it again.
				hearing.flush(c, now());
				invalidate(c);
				dispose(c);
			}
			await Promise.allSettled(inflight);
			if (deps.state && deps.memory.referenceInputs) await save();
		},
		dialoguePort,
		conversationAgent,
		attachWork(_value: AgencyWork) {
			// The agenda's work is its own research; the TODOs of the conversation are the dialogue's.
		},
		forgetInTransaction,
		planForgetInTransaction: (
			db: Database,
			input: { messageIds: readonly string[]; itemIds: readonly string[] },
		) => deps.state?.planForgetInTransaction(db, input) ?? {},
		invalidateTopics: schedule,
		async attend(id: string, report?: AgencyActivity) {
			if (!on()) throw new Error("agency_unavailable");
			if (
				report &&
				(!activity.update(id, report) || !report.visible || report.leaving)
			)
				return status(id);
			const entering = activeId !== id;
			const c = conv(id);
			activeId = id;
			display = { id, until: now() + 45_000 };
			if (entering) c.revision++;
			syncBusy();
			if (entering) await save();
			return status(id);
		},
		status,
		inspect: (id: string) => {
			const c = convs.get(id);
			return c
				? {
						snapshot: agendaEnvelope(c, now()),
						generation: c.generation,
						idle: status(id).idle,
					}
				: null;
		},
	};
}
