import type {
	AgencyRuntime,
	AgencySnapshot,
	IdleCheckpoint,
	IdlePlanner,
	createIdleScheduler,
} from "eumenes-agency";
import type { AgencyRecord } from "../../domains/dialogue";
import { getLogger } from "../../infrastructure/logger";
import type { AgencyHostDeps, Conv } from "./host-types";
const log = getLogger("agency");
/** A conversation the user has not touched for this long, and is not the active one, is forgotten. */
const IDLE_DROP_MS = 30 * 60_000;
/** Tracked conversations at most; the least recently touched inactive ones go first. */
const MAX_CONVERSATIONS = 20;

export function createConversationLifecycle(input: {
	deps: AgencyHostDeps;
	inflight: Set<Promise<unknown>>;
	convs: Map<string, Conv>;
	restored: Map<string, AgencyRecord>;
	state: { activeId: string | null };
	nowMs: () => number;
	newScope: () => string;
	newRuntime: (c: Conv, restore?: AgencySnapshot) => AgencyRuntime;
	newPlanner: (id: string, restore?: IdleCheckpoint) => IdlePlanner;
	newScheduler: (c: Conv) => ReturnType<typeof createIdleScheduler>;
	armReview: (c: Conv) => void;
	clearTimer: (handle: unknown) => void;
	digest: () => string;
	clearTopics: () => void;
}) {
	const {
		deps,
		convs,
		restored,
		state,
		nowMs,
		newScope,
		newRuntime,
		newPlanner,
		newScheduler,
		armReview,
		clearTimer,
		digest,
		clearTopics,
	} = input;
	const store = deps.store;

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
		const legacy =
			!!previous && !(previous.snapshot as AgencySnapshot).provenance;
		if (legacy && deps.state) {
			// Old checkpoints cannot certify the inputs of their derived state.
			const quarantine = store
				.write((db) => deps.state!.revokeInTransaction(db, id))
				.catch((error) =>
					log.warn("agency.restore_quarantined", {
						reason: error instanceof Error ? error.name : "restore_failed",
					}),
				);
			input.inflight.add(quarantine);
			void quarantine.finally(() => input.inflight.delete(quarantine));
		}
		const c = {
			epoch:
				(legacy ? previous!.epoch + 1 : previous?.epoch) ??
				(deps.state
					? store.read((db) => deps.state!.epochInTransaction(db, id))
					: 0),
			id,
			scope: legacy ? newScope() : (previous?.scope ?? newScope()),
			planner: newPlanner(
				id,
				legacy ? undefined : (previous?.idle as IdleCheckpoint | undefined),
			),
			generation: 1,
			background: null,
			opportunities: 0,
			calls: 0,
			touched: nowMs(),
			reportable: new Set<string>(),
		} as unknown as Conv;
		c.runtime = newRuntime(
			c,
			legacy ? undefined : (previous?.snapshot as AgencySnapshot | undefined),
		);
		if (previous && previous.settingsDigest !== digest())
			c.runtime.invalidate("settings.changed", nowMs());
		c.scheduler = newScheduler(c);
		convs.set(id, c);
		armReview(c);
		return c;
	}

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
		if (state.activeId !== c.id) {
			const previous = state.activeId ? convs.get(state.activeId) : undefined;
			if (previous) {
				previous.planner.setPaused(true, nowMs());
				previous.scheduler.rearm();
			}
			state.activeId = c.id;
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

	/** Drops every conversation (settings change, OFF, close). */
	function resetAll(reason: string) {
		for (const c of convs.values()) dropConv(c, reason);
		state.activeId = null;
		clearTopics();
	}

	/** Forgets conversations nobody has touched for a long time, and the oldest beyond the bound. */
	function prune() {
		const now = nowMs();
		const idle = (c: Conv) => c.id !== state.activeId && c.background === null;
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
	return {
		convOf,
		abortBackground,
		invalidate,
		activate,
		dropConv,
		resetAll,
		prune,
	};
}
