import type { Database } from "bun:sqlite";
import { listExclusions } from "eumenes-memory/sqlite";
import type { EvidenceExclusion } from "../../continuity";
import { listActiveTendencies } from "../repository";
import type { CurationDeps } from "./curation-shared";
import { everyItem } from "./immediate-shared";

/**
 * What is held back while a forget is only excluded (section 9.2), in one place: a message is withheld when it is
 * blocked (the database's blocks and the journal's) or when an excluded record stands on it (the closure delete
 * blocks it later); an item or a candidate is withheld when the library excludes it. What rests on a withheld
 * source (plans, ledger entries, tendencies, a background pass's reading) is left out meanwhile.
 */
export function createWithheld(deps: {
	scoped: CurationDeps["scoped"];
	blockedMessages: (
		db: Database,
		messageIds: Iterable<string>,
	) => ReadonlySet<string>;
}) {
	/** The items and candidates the library excludes right now. */
	function excluded(db: Database) {
		const { access, scopeKey } = deps.scoped(db, "memory.read");
		const listed = listExclusions(db, { contractVersion: 2, access, scopeKey });
		if (listed.status !== "ok") throw new Error("memory_blocked");
		const items = new Set<string>();
		const candidates = new Set<string>();
		for (const target of listed.targets)
			if (target.type === "state_item") items.add(target.itemId);
			else candidates.add(target.candidateId);
		return { items, candidates };
	}

	/** The blocked ones among the messages, and those an excluded item stands on. */
	function messages(
		db: Database,
		messageIds: Iterable<string>,
		known = excluded(db),
	): Set<string> {
		const wanted = new Set(messageIds);
		const out = new Set(deps.blockedMessages(db, wanted));
		if (known.items.size === 0 || wanted.size === 0) return out;
		const ids = [...known.items];
		for (let from = 0; from < ids.length; from += 500)
			for (const item of everyItem(db, deps, ids.slice(from, from + 500)))
				for (const ref of item.evidence)
					if (ref.namespace === "conversation" && wanted.has(ref.id))
						out.add(ref.id);
		return out;
	}

	return {
		messages: (db: Database, messageIds: readonly string[]) =>
			messages(db, messageIds),
		/** For continuity's reads: which sources of its plans and ledger entries are out. */
		sources: ((db, sources) => {
			const known = excluded(db);
			return {
				messageIds: messages(db, sources.messageIds, known),
				memoryItemIds: new Set(
					sources.memoryItemIds.filter((id) => known.items.has(id)),
				),
			};
		}) satisfies EvidenceExclusion,
		/** The active tendencies that stand on a withheld item, message or candidate: out of what the conversation reads. */
		tendencies(db: Database): Set<string> {
			const tendencies = listActiveTendencies(db);
			if (tendencies.length === 0) return new Set();
			const known = excluded(db);
			const blocked = messages(
				db,
				tendencies.flatMap((tendency) =>
					tendency.evidence.flatMap((entry) =>
						entry.namespace === "message" ? [entry.id] : [],
					),
				),
				known,
			);
			return new Set(
				tendencies
					.filter((tendency) =>
						tendency.evidence.some(
							(entry) =>
								(entry.namespace === "state" && known.items.has(entry.id)) ||
								(entry.namespace === "candidate" &&
									known.candidates.has(entry.id)) ||
								(entry.namespace === "message" && blocked.has(entry.id)),
						),
					)
					.map((tendency) => tendency.id),
			);
		},
	};
}
