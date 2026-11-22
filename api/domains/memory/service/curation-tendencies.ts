import type { Database } from "bun:sqlite";
import type { CurationItem, CurationResult } from "../contracts";
import {
	countActiveTendencies,
	getTendency,
	insertTendency,
	retireTendency,
	updateTendency,
	type TendencyEvidence,
} from "../repository";
import { applied, rejected, type CurationDeps } from "./curation-shared";
import type { StateWriter } from "./curation-state";

export const MAX_ACTIVE_TENDENCIES = 20;
export const MAX_TENDENCY_CHARS = 120;

/** Tendencies. */
export function createTendencyOps(deps: CurationDeps, writer: StateWriter) {
	const { continuity, clock } = deps;
	const { items } = writer;

	// ---- tendencies ----

	/**
	 * The evidence of a tendency: at least two distinct items that still count: State items, and the conversation's
	 * open plans (`continuity`; a plan keeps the id of the short-term note it was moved from).
	 */
	function tendencyEvidence(
		db: Database,
		conversationId: string,
		evidence: ReadonlyArray<TendencyEvidence>,
	): TendencyEvidence[] | null {
		if (evidence.length < 2) return null;
		const activeState = new Set(
			items(db, false)
				.filter((state) => state.status === "active")
				.map((state) => state.itemId),
		);
		const livePlans = new Set(
			continuity.plans
				.listInTransaction(db, { conversationId })
				.map((plan) => plan.id),
		);
		const out: TendencyEvidence[] = [];
		for (const entry of evidence) {
			if (entry.namespace === "state" && activeState.has(entry.id))
				out.push({ namespace: "state", id: entry.id });
			else if (entry.namespace === "continuity" && livePlans.has(entry.id))
				out.push({ namespace: "continuity", id: entry.id });
			else return null;
		}
		return new Set(out.map((entry) => `${entry.namespace}:${entry.id}`))
			.size === out.length
			? out
			: null;
	}
	function tendencyAdd(
		db: Database,
		conversationId: string,
		item: Extract<CurationItem, { op: "tendency_add" }>,
	): CurationResult {
		const text = item.text.trim();
		if (text === "" || [...text].length > MAX_TENDENCY_CHARS)
			return rejected("tendency_add", "invalid_input");
		const evidence = tendencyEvidence(db, conversationId, item.evidence);
		if (!evidence) return rejected("tendency_add", "invalid_input");
		if (countActiveTendencies(db) >= MAX_ACTIVE_TENDENCIES)
			return rejected("tendency_add", "limit_reached");
		const now = clock();
		const id = deps.id();
		insertTendency(db, {
			id,
			text,
			evidence,
			status: "active",
			revision: 1,
			createdAt: now,
			updatedAt: now,
		});
		return applied("tendency_add", { id, revision: 1 });
	}
	function tendencyUpdate(
		db: Database,
		conversationId: string,
		item: Extract<CurationItem, { op: "tendency_update" }>,
	): CurationResult {
		const text = item.text.trim();
		if (text === "" || [...text].length > MAX_TENDENCY_CHARS)
			return rejected("tendency_update", "invalid_input");
		const evidence = tendencyEvidence(db, conversationId, item.evidence);
		if (!evidence) return rejected("tendency_update", "invalid_input");
		const row = getTendency(db, item.tendencyId);
		if (!row) return rejected("tendency_update", "unknown_item");
		if (row.status !== "active" || row.revision !== item.revision)
			return rejected("tendency_update", "item_changed");
		return updateTendency(
			db,
			item.tendencyId,
			item.revision,
			{ text, evidence },
			clock(),
		)
			? applied("tendency_update", {
					id: item.tendencyId,
					revision: item.revision + 1,
				})
			: rejected("tendency_update", "item_changed");
	}
	function tendencyRetire(
		db: Database,
		item: Extract<CurationItem, { op: "tendency_retire" }>,
	): CurationResult {
		const row = getTendency(db, item.tendencyId);
		if (!row) return rejected("tendency_retire", "unknown_item");
		return retireTendency(db, item.tendencyId, item.revision, clock())
			? applied("tendency_retire", {
					id: item.tendencyId,
					revision: item.revision + 1,
				})
			: rejected("tendency_retire", "item_changed");
	}

	return {
		tendencyAdd,
		tendencyUpdate,
		tendencyRetire,
	};
}
