import type { Database } from "bun:sqlite";
import type { AgencyHostDeps } from "./host-types";
import { alwaysOnSources } from "../../domains/dialogue";
import { staleInputSources } from "./input";
import { persistAlwaysOnMemory } from "./always-on-memory";
import {
	alwaysOnEnvelope,
	alwaysOnRecord,
	type AlwaysOnScope,
} from "./always-on-scope";
export function createAlwaysOnCheckpoints(input: {
	deps: AgencyHostDeps;
	convs: Map<string, AlwaysOnScope>;
	now(): number;
	hostDigest: string;
	feed(): { cursor: number; activeId: string | null };
	saved(captures: { id: string; revision: number }[], cursor: number): void;
	invalidate(c: AlwaysOnScope): void;
}) {
	const { deps, convs, now, hostDigest, feed, saved, invalidate } = input;
	function saveInTransaction(db: Database) {
		for (const c of convs.values()) {
			const record = persistAlwaysOnMemory(
				deps,
				db,
				alwaysOnRecord(c, hostDigest),
			);
			if (!deps.state!.saveInTransaction(db, record, now()))
				throw new Error("agency_checkpoint_stale");
		}
		deps.state!.saveFeedInTransaction(db, feed().cursor, feed().activeId);
	}
	async function save() {
		if (!deps.state || !deps.memory.referenceInputs) return false;
		const captures = [...convs.values()].map((c) => ({
			c,
			revision: c.revision,
			record: alwaysOnRecord(c, hostDigest),
		}));
		const capturedFeed = feed();
		const accepted = await deps.store.write((db) => {
			if (
				captures.some(
					({ c, revision }) =>
						convs.get(c.id) !== c ||
						c.revision !== revision ||
						c.epoch !== deps.state!.epochInTransaction(db, c.id),
				) ||
				feed().cursor !== capturedFeed.cursor ||
				feed().activeId !== capturedFeed.activeId
			)
				return false;
			for (const { record } of captures)
				if (
					!deps.state!.saveInTransaction(
						db,
						persistAlwaysOnMemory(deps, db, record),
						now(),
					)
				)
					throw new Error("agency_checkpoint_stale");
			deps.state!.saveFeedInTransaction(
				db,
				capturedFeed.cursor,
				capturedFeed.activeId,
			);
			return true;
		});
		if (accepted) {
			saved(
				captures.map(({ c, revision }) => ({ id: c.id, revision })),
				capturedFeed.cursor,
			);
		}
		return accepted;
	}
	async function refresh(c: AlwaysOnScope) {
		const stale = deps.store.read((db) =>
			staleInputSources(deps, db, alwaysOnSources(alwaysOnEnvelope(c))),
		);
		if (!stale.length) return;
		invalidate(c);
		c.agent.forget(stale);
		const forgotten = new Set(c.agent.snapshot().forgotten);
		c.tickets = c.tickets.filter(
			(t) => !t.inputs.some((s) => forgotten.has(s)),
		);
		await deps.store.write((db) =>
			deps.state!.forgetInTransaction(db, {
				messageIds: [],
				itemIds: [],
				sourceRefs: stale,
			}),
		);
	}

	function forgetInTransaction(
		db: Database,
		purge: Parameters<
			NonNullable<AgencyHostDeps["state"]>["forgetInTransaction"]
		>[1],
	) {
		for (const c of convs.values()) {
			const refs = deps.state!.forgetReferencesInTransaction(
				db,
				c.id,
				c.scope,
				purge,
			);
			if (
				![
					...alwaysOnSources(alwaysOnEnvelope(c)),
					...(c.pendingInput?.sources ?? []),
				].some((ref) => refs.includes(ref))
			)
				continue;
			invalidate(c);
			c.agent.forget(refs);
			const forgotten = new Set(c.agent.snapshot().forgotten);
			c.tickets = c.tickets.filter(
				(t) => !t.inputs.some((s) => forgotten.has(s)),
			);
		}
		deps.state?.forgetInTransaction(db, purge);
	}
	return { save, saveInTransaction, refresh, forgetInTransaction };
}
