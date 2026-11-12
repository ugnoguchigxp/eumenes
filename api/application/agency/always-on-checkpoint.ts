import type { Database } from "bun:sqlite";
import type { AgencyHostDeps } from "./host-types";
import {
	agendaSources,
	baseRef,
	forgetProfile,
	type AgendaNote,
	type AgendaResearchTicket,
} from "../../domains/dialogue";
import { staleInputSources } from "./input";
import {
	agendaEnvelope,
	agendaRecord,
	type AgendaScope,
} from "./always-on-scope";

/** What a transaction changes in a scope before the scope itself does (a returned work, adopted atomically). */
export type ScopePatch = {
	tickets: AgendaResearchTicket[];
	notes: AgendaNote[];
};

export function createAgendaCheckpoints(input: {
	deps: AgencyHostDeps;
	convs: Map<string, AgendaScope>;
	now(): number;
	hostDigest: string;
	feed(): { cursor: number; activeId: string | null };
	saved(captures: { id: string; revision: number }[], cursor: number): void;
	invalidate(c: AgendaScope): void;
}) {
	const { deps, convs, now, hostDigest, feed, saved, invalidate } = input;

	/** Drops what rests on `refs` from the running agent, the held tickets and the notes. */
	function forgetRefs(c: AgendaScope, refs: Iterable<string>) {
		const set = new Set(refs);
		const gone = (list: readonly string[]) =>
			list.some((ref) => set.has(ref) || set.has(baseRef(ref)));
		const view = c.agent.view();
		// A corrected line is `<id>:c<seq>` for the agent: it goes with the message.
		const aliases = [
			...view.said.map((s) => s.id),
			...view.items.flatMap((i) => i.refs),
		].filter((ref) => set.has(baseRef(ref)));
		const lost = c.notes.filter((n) => gone(n.refs));
		const lostRefs = new Set(lost.map((n) => `note:${n.id}`));
		c.agent.forget([...set, ...aliases, ...lostRefs]);
		// The note goes back to before the words it read; a writer pass in flight is not kept.
		c.profile = forgetProfile(c.profile, set) ?? c.profile;
		c.forgetSeq++;
		c.notes = c.notes.filter((n) => !lost.includes(n));
		c.tickets = c.tickets.filter(
			(t) =>
				!gone([...t.refs, ...t.inputs]) && !t.refs.some((r) => lostRefs.has(r)),
		);
		for (const [item, done] of c.finished)
		if (lost.length)
			deps.noteDocuments?.forget(
				c.id,
				lost.map((n) => n.id),
			);
			if (done.note && lost.some((n) => n.id === done.note!.id))
				c.finished.delete(item);
		c.revision++;
	}

	function saveInTransaction(db: Database, patch?: Map<string, ScopePatch>) {
		for (const c of convs.values()) {
			const record = agendaRecord(c, hostDigest, now());
			const change = patch?.get(c.id);
			if (change) {
				const snapshot = {
					...(record.snapshot as ReturnType<typeof agendaEnvelope>),
					...change,
				};
				record.snapshot = snapshot;
				record.sourceRefs = agendaSources(snapshot);
			}
			persist(db, record);
		}
		deps.state!.saveFeedInTransaction(db, feed().cursor, feed().activeId);
	}

	function persist(db: Database, record: ReturnType<typeof agendaRecord>) {
		if (!deps.state!.saveInTransaction(db, record, now()))
			throw new Error("agency_checkpoint_stale");
		deps.state!.refreshDependenciesInTransaction(
			db,
			record.conversationId,
			record.scope,
			record.sourceRefs,
		);
	}

	async function refresh(c: AgendaScope) {
		const stale = deps.store.read((db) =>
			staleInputSources(deps, db, agendaSources(agendaEnvelope(c, now()))),
		);
		if (!stale.length) return;
		invalidate(c);
		forgetRefs(c, stale);
		await deps.store.write((db) =>
			deps.state!.forgetInTransaction(db, {
				messageIds: [],
				itemIds: [],
				sourceRefs: stale,
			}),
		);
	}

	async function save() {
		if (!deps.state || !deps.memory.referenceInputs) return false;
		for (const c of convs.values()) if (convs.get(c.id) === c) await refresh(c);
		const captures = [...convs.values()].map((c) => ({
			c,
			revision: c.revision,
			record: agendaRecord(c, hostDigest, now()),
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
			for (const { record } of captures) persist(db, record);
			deps.state!.saveFeedInTransaction(
				db,
				capturedFeed.cursor,
				capturedFeed.activeId,
			);
			return true;
		});
		if (accepted)
			saved(
				captures.map(({ c, revision }) => ({ id: c.id, revision })),
				capturedFeed.cursor,
			);
		return accepted;
	}

	/** A purge of the user's data: the running agents forget what rests on it, then the saved records do. */
	function forgetInTransaction(
		db: Database,
		purge: Parameters<
			NonNullable<AgencyHostDeps["state"]>["forgetInTransaction"]
		>[1],
	) {
		for (const c of convs.values()) {
			const refs = new Set(
				deps.state!.forgetReferencesInTransaction(db, c.id, c.scope, purge),
			);
			const cited = new Set([
				...agendaSources(agendaEnvelope(c, now())),
				...c.agent.view().said.map((s) => baseRef(s.id)),
			]);
			if (![...refs].some((ref) => cited.has(ref))) continue;
			invalidate(c);
			forgetRefs(c, refs);
		}
		deps.state?.forgetInTransaction(db, purge);
	}

	return { save, saveInTransaction, refresh, forgetInTransaction, forgetRefs };
}
