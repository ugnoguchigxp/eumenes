import type { Database } from "bun:sqlite";
import { classifyValidity, periodFromStateMs } from "eumenes-memory";
import {
	assertUserState,
	deactivateState,
	listState,
} from "eumenes-memory/sqlite";
import type { HostSourceState, StateItem } from "eumenes-memory/sqlite";
import {
	type CurationItem,
	type CurationRejection,
	type CurationResult,
	type stateKinds,
} from "../contracts";
import { putProvenance } from "../repository";
import {
	MAX_ACTIVE_ITEMS,
	applied,
	rejected,
	type CurationDeps,
	type Evidence,
} from "./curation-shared";
import type { ValidityBounds } from "./curation-evidence";

export type StateWrite =
	| { ok: true; item: StateItem; changed: boolean; reconfirmed: boolean }
	| { ok: false; reason: CurationRejection };

/** The State items and the one write of a State version (the building blocks of remember, update and merge). */
export function createStateWriter(deps: CurationDeps) {
	const { clock } = deps;

	function items(db: Database, includeInactive: boolean): readonly StateItem[] {
		const listed = listState(db, {
			...deps.scoped(db, "memory.write"),
			includeInactive,
		});
		if (listed.status !== "ok") throw new Error("memory_blocked");
		return listed.items;
	}

	/**
	 * The one write of a State version. `replaces` is added when an active item of the same fact exists and the value
	 * differs or a validity is given; the same value is left alone (the library reports it unchanged). `force` (an
	 * explicit request) always leaves a new, user-confirmed version, also for the same value.
	 */
	function writeState(
		db: Database,
		w: {
			kind: (typeof stateKinds)[number];
			semanticKey: string;
			text: string;
			negated: boolean;
			evidence: readonly Evidence[];
			sources: readonly HostSourceState[];
			origin: "user_confirmed" | "agent_inferred";
			validity: ValidityBounds;
			force: boolean;
		},
	): StateWrite {
		const listed = items(db, true);
		const active = listed.find(
			(item) =>
				item.kind === w.kind &&
				item.subject === "self" &&
				item.semanticKey === w.semanticKey &&
				item.status === "active",
		);
		const now = deps.atMs();
		// An expired item no longer occupies the profile, whatever its status says.
		const counted = listed.filter(
			(item) =>
				item.status === "active" &&
				classifyValidity(
					periodFromStateMs(item.validFromMs, item.validUntilMs),
					now,
				) !== "past",
		).length;
		if (counted >= MAX_ACTIVE_ITEMS && !active)
			return { ok: false, reason: "limit_reached" };
		const polarity = w.negated ? "negated" : "affirmed";
		const sameValue =
			active !== undefined &&
			active.value.text === w.text &&
			active.value.polarity === polarity &&
			Object.keys(active.value.attributes ?? {}).length === 0;
		// The library turns "replaces + the same value" into an in-place promotion of the old item (same id, its first
		// evidence). An explicit request must leave a new version standing on the request's own message, so the old one is
		// stopped and the value is written afresh.
		const reconfirm = active !== undefined && w.force && sameValue;
		if (reconfirm) {
			const stopped = deactivateState(db, {
				...deps.scoped(db, "memory.write"),
				clock: { atMs: now },
				itemId: active.itemId,
				expectedRevision: active.revision,
			});
			if (stopped.status !== "applied")
				return { ok: false, reason: "conflict" };
		}
		const replace =
			active !== undefined &&
			!reconfirm &&
			(w.force ||
				!sameValue ||
				(w.validity !== null && w.validity !== "invalid"));
		const result = assertUserState(db, {
			...deps.scoped(db, "memory.write"),
			clock: { atMs: now },
			kind: w.kind,
			subject: "self",
			semanticKey: w.semanticKey,
			value: { text: w.text, polarity },
			evidence: w.evidence.map((span) => ({
				source: span.source,
				quote: span.quote,
			})),
			sources: w.sources,
			origin: w.origin,
			...(w.validity && w.validity !== "invalid"
				? { validity: w.validity }
				: {}),
			...(replace && active
				? { replaces: { itemId: active.itemId, revision: active.revision } }
				: {}),
		});
		if (result.status === "applied" || result.status === "unchanged") {
			// No immediate change: a replaced or negated value is not content that must stop being used (only a stop or a
			// forget is). A run in flight stays adoptable; the next published window carries the new version.
			return {
				ok: true,
				item: result.item,
				changed: result.status === "applied",
				reconfirmed: reconfirm,
			};
		}
		if (result.status === "rejected") {
			switch (result.reasonCode) {
				case "SOURCE_TOMBSTONED":
					return { ok: false, reason: "source_tombstoned" };
				case "QUOTE_MISMATCH":
				case "EVIDENCE_NOT_IN_INPUT":
				case "SOURCE_STALE":
					return { ok: false, reason: "invalid_source" };
				default:
					return { ok: false, reason: "conflict" };
			}
		}
		return { ok: false, reason: "conflict" };
	}

	function stored(
		op: CurationItem["op"],
		db: Database,
		written: StateWrite,
		built: { quoteMatched: boolean; runId: string | null },
		explicit: boolean,
	): CurationResult {
		if (!written.ok) return rejected(op, written.reason);
		// Who asked is recorded when the item was created or actually changed, never on a no-op.
		if (written.changed)
			putProvenance(
				db,
				written.item.itemId,
				built.runId,
				explicit ? "request" : "agent",
				clock(),
				built.quoteMatched,
			);
		return applied(op, {
			id: written.item.itemId,
			revision: written.item.revision,
			changed: written.changed,
			quoteMatched: built.quoteMatched,
			reconfirmed: written.reconfirmed,
		});
	}

	/** The active item a ref points at, exactly at the revision the steward showed the model. */
	function activeAt(
		db: Database,
		itemId: string,
		revision: number,
	): { item: StateItem } | { reason: CurationRejection } {
		const found = items(db, true).find(
			(candidate) => candidate.itemId === itemId,
		);
		if (!found) return { reason: "unknown_item" };
		if (
			found.status !== "active" ||
			found.revision !== revision ||
			found.subject !== "self"
		)
			return { reason: "item_changed" };
		return { item: found };
	}

	return { items, writeState, stored, activeAt };
}
export type StateWriter = ReturnType<typeof createStateWriter>;
