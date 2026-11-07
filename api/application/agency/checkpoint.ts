import { persistMemory } from "./memory";
import { getLogger } from "../../infrastructure/logger";
import { toErrorCode } from "../../infrastructure/error-code";
import type { AgencyRecord } from "../../domains/dialogue";
import type { AgencyHostDeps, Conv } from "./host-types";
import { snapshotRefs } from "./research";
/** Feed cursor and all scopes it advanced are one checkpoint in the host writer. */
export function createCheckpoint(input: {
	deps: AgencyHostDeps;
	inflight: Set<Promise<unknown>>;
	convs: Map<string, Conv>;
	nowMs: () => number;
	digest: () => string;
	feed: () => { cursor: number; activeId: string | null };
}) {
	const { deps, convs } = input;
	const api = {
		save(c: Conv) {
			if (!deps.state) return Promise.resolve(true);
			const captures = [...convs.values()].map((conv) => ({
				conv,
				generation: conv.generation,
				record: {
					conversationId: conv.id,
					epoch: conv.epoch,
					scope: conv.scope,
					snapshot: conv.runtime.snapshot(),
					idle: conv.planner.checkpoint(),
					settingsDigest: input.digest(),
					sourceRefs: snapshotRefs(conv.runtime),
				} satisfies AgencyRecord,
			}));
			const feed = input.feed();
			return deps.store.write((db) => {
				if (
					convs.get(c.id) !== c ||
					captures.some(
						(x) =>
							convs.get(x.conv.id) !== x.conv ||
							x.conv.generation !== x.generation ||
							x.conv.runtime.snapshot().state.revision !==
								(x.record.snapshot as import("eumenes-agency").AgencySnapshot)
									.state.revision ||
							x.conv.runtime.snapshot().observations.length !==
								(x.record.snapshot as import("eumenes-agency").AgencySnapshot)
									.observations.length ||
							deps.state!.epochInTransaction(db, x.conv.id) !== x.conv.epoch,
					)
				)
					return false;
				for (const x of captures)
					if (
						!deps.state!.saveInTransaction(
							db,
							persistMemory(deps, db, x.record),
							input.nowMs(),
						)
					)
						throw new Error("agency_checkpoint_stale");
				deps.state!.saveFeedInTransaction(db, feed.cursor, feed.activeId);
				return true;
			});
		},
	};
	let queued: Conv | undefined;
	let saving: Promise<void> | undefined;
	function drain() {
		if (saving || !queued) return;
		const task = (async () => {
			while (queued) {
				const next = queued;
				queued = undefined;
				await api.save(next);
			}
		})().catch((error) =>
			getLogger("agency").warn("agency.checkpoint_failed", {
				reason: toErrorCode(error, "checkpoint_failed"),
			}),
		);
		saving = task;
		input.inflight.add(task);
		void task.finally(() => {
			saving = undefined;
			input.inflight.delete(task);
			drain();
		});
	}
	return {
		...api,
		trackSave(c: Conv) {
			queued = c;
			drain();
		},
	};
}
