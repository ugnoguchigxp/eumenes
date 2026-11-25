import type { Database } from "bun:sqlite";
import type { AgencyHostDeps } from "./host-types";
import {
	agendaSources,
	baseRef,
	type AgendaNote,
	type AgendaResearchTicket,
} from "../../domains/dialogue";
import { staleInputSources, staleMemoryRefs } from "./input";
import { currentRef, reviewRefs } from "./always-on-recall";
import {
	agendaEnvelope,
	agendaRecord,
	citableNotes,
	type AgendaScope,
} from "./always-on-scope";

/** What a transaction changes in a scope before the scope itself does (a returned work, adopted atomically). */
export type ScopePatch = {
	tickets: AgendaResearchTicket[];
	notes: AgendaNote[];
	droppedItems?: Set<string>;
};

export function createAgendaCheckpoints(input: {
	deps: AgencyHostDeps;
	convs: Map<string, AgendaScope>;
	now(): number;
	hostDigest: string;
	/** The revision of each scope as last saved (the host keeps it); a scope at another revision is dirty. */
	persisted: ReadonlyMap<string, number>;
	feed(): { cursor: number; activeId: string | null };
	saved(captures: { id: string; revision: number }[], cursor: number): void;
	invalidate(c: AgendaScope): void;
}) {
	const { deps, convs, now, hostDigest, persisted, feed, saved, invalidate } =
		input;

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
		// A note the list let go is forgotten with the words it read, as one it holds.
		const lost = citableNotes(c).filter((n) =>
			gone([...n.refs, ...(n.inputs ?? [])]),
		);
		const lostRefs = new Set(lost.map((n) => `note:${n.id}`));
		const lostTickets = new Set(
			c.tickets.filter(
				(t) =>
					gone([...t.refs, ...t.inputs]) || t.refs.some((r) => lostRefs.has(r)),
			),
		);
		c.agent.forget([
			...set,
			...aliases,
			...lostRefs,
			...[...lostTickets].map((ticket) => ticket.itemId),
		]);
		if (lostTickets.size) c.agent.infoChanged(now());
		// A records pass in flight is not kept (it read the words as they were).
		c.forgetSeq++;
		// Thoughts carry no refs: any forget takes them all off the screen.
		if (c.thoughts.length) {
			c.thoughts = [];
			c.thoughtsChanged();
		}
		c.notes = c.notes.filter((n) => !lostRefs.has(`note:${n.id}`));
		c.retired = c.retired.filter((n) => !lostRefs.has(`note:${n.id}`));
		if (lost.length)
			deps.noteDocuments?.forget(
				c.id,
				lost.map((n) => n.id),
			);
		c.tickets = c.tickets.filter((t) => !lostTickets.has(t));
		for (const ticket of lostTickets) {
			c.assignments.delete(ticket.itemId);
			c.observed.delete(ticket.id);
		}
		for (const [key, refusal] of c.researchRefusals)
			if (gone(refusal.sources)) c.researchRefusals.delete(key);
		for (const [item, done] of c.finished)
			if (done.note && lost.some((n) => n.id === done.note!.id))
				c.finished.delete(item);
		c.revision++;
	}

	function saveInTransaction(db: Database, patch?: Map<string, ScopePatch>) {
		for (const c of convs.values()) {
			const record = agendaRecord(c, hostDigest, now());
			const change = patch?.get(c.id);
			if (change) {
				const original = record.snapshot as ReturnType<typeof agendaEnvelope>;
				const snapshot = {
					...original,
					tickets: change.tickets,
					notes: change.notes,
				};
				if (change.droppedItems?.size) {
					const keep = (item: { id: string }) =>
						!change.droppedItems!.has(item.id);
					snapshot.agent.items = snapshot.agent.items.filter(keep);
					snapshot.assignments = snapshot.assignments?.filter(
						(item) => !change.droppedItems!.has(item.itemId),
					);
				}
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
		let renames = new Map<string, string>();
		const stale = deps.store.read((db) => {
			// What the agent cites of a version a consolidation replaced is the version that took its place.
			renames = new Map(
				c.agent
					.view()
					.items.flatMap((i) => i.refs)
					.filter((ref) => ref.startsWith("memory:"))
					.flatMap((ref) => {
						const now = currentRef(deps, db, ref);
						return now === ref ? [] : [[ref, now] as const];
					}),
			);
			// Replies can see live items whose status excludes them from the checkpoint.
			const sources = [
				...new Set([
					...agendaSources(agendaEnvelope(c, now())),
					...c.agent.view().items.flatMap((item) => item.refs),
				]),
			];
			// What rests on a corrected record is held under review (marks), not forgotten with it.
			const review = reviewRefs(deps, db);
			return [
				...staleInputSources(deps, db, sources),
				...staleMemoryRefs(deps, db, sources).filter((ref) => !review.has(ref)),
			];
		});
		// Saved with the new references: a restart brings the items back resting on the current version.
		if (
			renames.size !== c.renames.size ||
			[...renames].some(([from, to]) => c.renames.get(from) !== to)
		) {
			c.renames = renames;
			c.revision++;
		}
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

	/**
	 * Saves the scopes that changed since their last save (and the feed). `refreshed`: the caller refreshed every scope
	 * just before, so the stale sources are not looked up again. The adoption still checks every scope (its revision and
	 * epoch), the changed or not.
	 */
	async function save(options: { refreshed?: boolean } = {}) {
		if (!deps.state || !deps.memory.referenceInputs) return false;
		if (!options.refreshed)
			for (const c of convs.values())
				if (convs.get(c.id) === c) await refresh(c);
		const captures = [...convs.values()].map((c) => ({
			c,
			revision: c.revision,
		}));
		const dirty = captures.filter(
			({ c, revision }) => persisted.get(c.id) !== revision,
		);
		const records = dirty.map(({ c }) => agendaRecord(c, hostDigest, now()));
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
			for (const record of records) persist(db, record);
			deps.state!.saveFeedInTransaction(
				db,
				capturedFeed.cursor,
				capturedFeed.activeId,
			);
			return true;
		});
		if (accepted)
			saved(
				dirty.map(({ c, revision }) => ({ id: c.id, revision })),
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

	/** Saves one scope's checkpoint in the caller's transaction (the records writer's position goes with its writes). */
	function saveScopeInTransaction(db: Database, c: AgendaScope) {
		persist(db, agendaRecord(c, hostDigest, now()));
	}

	/**
	 * The memory excluded these records (a forget on its way): what the agent holds on them, its words, its notes and
	 * its tickets go at once, as the closure delete will make them go for good. Only a scope that cites them is touched.
	 */
	function excludeRefs(c: AgendaScope, refs: readonly string[]) {
		const set = new Set(refs);
		const cited = new Set([
			...agendaSources(agendaEnvelope(c, now())),
			...c.agent.view().said.map((s) => baseRef(s.id)),
			...c.agent.view().items.flatMap((i) => i.refs.map(baseRef)),
		]);
		if (![...set].some((ref) => cited.has(ref))) return;
		invalidate(c);
		forgetRefs(c, set);
	}

	return {
		save,
		saveInTransaction,
		saveScopeInTransaction,
		refresh,
		forgetInTransaction,
		forgetRefs,
		excludeRefs,
	};
}
