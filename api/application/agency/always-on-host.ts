import type { Database } from "bun:sqlite";
import { createAlwaysOnCheckpoints } from "./always-on-checkpoint";
import { runAlwaysOnCycle, collectAlwaysOnResults } from "./always-on-cycle";
import { createAlwaysOnPorts } from "./always-on-ports";
import { pumpAlwaysOnHost } from "./always-on-feed";
import { isAlwaysOnSnapshot, type AgencyRecord } from "../../domains/dialogue";
import { getLogger } from "../../infrastructure/logger";
import { toErrorCode } from "../../infrastructure/error-code";
import { fixedInput } from "./input";
import {
	createAlwaysOnScope,
	alwaysOnEnvelope,
	type AlwaysOnScope,
} from "./always-on-scope";
import type { AgencyHostDeps } from "./host-types";
import type { AgencyWork } from "./work";
import { createAgencyActivity } from "./always-on-activity";
import type { AgencyActivity } from "../../domains/dialogue/contracts/agency-status";
/** Host orchestration only. Meaning and action choice stay in the adopted always-on agent. */
export function createAlwaysOnHost(deps: AgencyHostDeps) {
	const now = deps.nowMs ?? Date.now;
	const log = getLogger("agency");
	const convs = new Map<string, AlwaysOnScope>();
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
	let work: AgencyWork | undefined;
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
		setTimer: deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
		clearTimer:
			deps.clearTimer ??
			((id) => clearTimeout(id as ReturnType<typeof setTimeout>)),
	});
	const on = () =>
		started &&
		!closed &&
		deps.settings.get().agency.runtime === "always-on" &&
		deps.memory.status().healthy &&
		!!deps.state &&
		!!deps.memory.referenceInputs;
	const track = <T>(p: Promise<T>): Promise<T> => {
		inflight.add(p);
		void p.finally(() => inflight.delete(p)).catch(() => {});
		return p;
	};
	function make(id: string, previous?: AgencyRecord) {
		const c = createAlwaysOnScope({
			deps,
			id,
			epoch:
				previous?.epoch ??
				deps.store.read((db) => deps.state!.epochInTransaction(db, id)),
			...(previous ? { previous } : {}),
			now,
			run: (c) => track(run(c)),
			settled: async (c) => {
				if (closed || convs.get(c.id) !== c) return;
				c.revision++;
				await track(save()).catch((error) =>
					log.warn("agency.checkpoint_failed", {
						reason: toErrorCode(error, "checkpoint_failed"),
					}),
				);
			},
		});
		convs.set(id, c);
		if (previous) {
			persisted.set(id, c.revision);
			recovering.add(id);
		}
		return c;
	}
	function conv(id: string) {
		const current = convs.get(id);
		if (current) return current;
		const record = deps.store.read((db) =>
			deps.state!.recordsInTransaction(db).find((r) => r.conversationId === id),
		);
		if (record && !isAlwaysOnSnapshot(record.snapshot))
			throw new Error("agency_runtime_not_recovered");
		return make(id, record);
	}
	function busy(c: AlwaysOnScope) {
		return (
			activity.busy(c.id) ||
			deps.inference.foregroundBusy() ||
			deps.store.read((db) => deps.conversationBusy(db, c.id))
		);
	}
	function syncBusy() {
		for (const c of convs.values()) {
			const next =
				busy(c) || c.id !== activeId || !on() || recovering.has(c.id);
			if (next !== c.busy) {
				c.busy = next;
				if (next) c.heartbeat.enter();
				else {
					c.heartbeat.leave(now());
					c.heartbeat.event(now());
				}
			}
			c.scheduler.rearm();
		}
	}
	function invalidate(c: AlwaysOnScope) {
		c.generation++;
		c.controller?.abort();
		c.agent.invalidate();
		c.revision++;
	}
	const { save, saveInTransaction, refresh, forgetInTransaction } =
		createAlwaysOnCheckpoints({
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
	const run = (c: AlwaysOnScope) =>
		runAlwaysOnCycle(
			{
				deps,
				convs,
				on,
				now,
				busy,
				refresh,
				digest,
				save,
				active: () => activeId,
			},
			c,
		);
	const collect = () =>
		collectAlwaysOnResults({
			deps,
			convs,
			now,
			hostDigest,
			conv,
			make,
			invalidate,
			saveInTransaction,
			collected() {
				for (const c of convs.values()) persisted.set(c.id, c.revision);
				savedCursor = cursor;
			},
		});
	const { dialoguePort, conversationAgent, status } = createAlwaysOnPorts({
		deps,
		convs,
		now,
		active: () => activeId,
		display: () => display,
		changed: () => {
			requested = true;
		},
	});
	const pump = () =>
		pumpAlwaysOnHost({
			deps,
			convs,
			persisted,
			recovering,
			on,
			now,
			refresh,
			invalidate,
			conv,
			work,
			collect,
			syncBusy,
			feed: () => ({ cursor, activeId, display }),
			adopt(value) {
				cursor = value.cursor;
				activeId = value.activeId;
			},
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
					if (
						!isAlwaysOnSnapshot(r.snapshot) ||
						r.settingsDigest !== hostDigest
					)
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
				if (isAlwaysOnSnapshot(r.snapshot)) make(r.conversationId, r);
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
			for (const c of convs.values()) {
				invalidate(c);
				c.scheduler.dispose();
			}
			await Promise.allSettled(inflight);
			if (deps.state && deps.memory.referenceInputs) await save();
		},
		dialoguePort,
		conversationAgent,
		attachWork(value: AgencyWork) {
			work = value;
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
			if (entering) {
				c.heartbeat.event(now());
				c.revision++;
			}
			syncBusy();
			if (entering) await save();
			return status(id);
		},
		status,
		inspect: (id: string) => {
			const c = convs.get(id);
			return c
				? {
						snapshot: alwaysOnEnvelope(c),
						generation: c.generation,
						idle: status(id).idle,
					}
				: null;
		},
	};
}
