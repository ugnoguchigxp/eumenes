import { z } from "zod";
import type { Database } from "bun:sqlite";
import {
	deactivateState,
	reactivateState,
	type StateItem,
} from "eumenes-memory/sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import {
	getTendency,
	isBlocked,
	purgeWindows,
	retireTendency,
	bumpForgetSeq,
} from "../repository";
import { listStoredTendencies, restoreTendency } from "../repository/tendency";
import { createEvidence } from "./curation-evidence";
import { MAX_ACTIVE_ITEMS, type CurationDeps } from "./curation-shared";

export const memoryMaintenanceInput = z.strictObject({
	conversationId: z.string().min(1).max(120),
	active: z.boolean(),
	refs: z
		.array(
			z.strictObject({
				kind: z.enum(["state", "note", "tendency"]),
				id: z.string().min(1).max(240),
				revision: z.number().int().positive(),
			}),
		)
		.min(1)
		.max(200),
});

/** This owner-only surface changes use, never text, meaning, origin, sources or forget fences. */
export function createMemoryMaintenance(
	store: SqliteStore,
	deps: CurationDeps,
	states: (db: Database) => readonly StateItem[],
) {
	const evidence = createEvidence(deps);
	function inventory(db: Database, conversationId: string) {
		if (!deps.ready()) throw new Error("memory_unavailable");
		return [
			...states(db)
				.filter(
					(s) =>
						s.subject === "self" &&
						(s.status === "active" || s.status === "inactive"),
				)
				.map((s) => ({
					kind: "state" as const,
					id: s.itemId,
					revision: s.revision,
					active: s.status === "active",
					text: s.value.text,
				})),
			...deps.continuity
				.ownerItemsInTransaction(db, conversationId)
				.map((s) => ({
					kind: "note" as const,
					id: s.id,
					revision: s.revision,
					active: s.status === "active",
					text: s.text,
				})),
			...listStoredTendencies(db).map((s) => ({
				kind: "tendency" as const,
				id: s.id,
				revision: s.revision,
				active: s.status === "active",
				text: s.text,
			})),
		];
	}
	function plan(db: Database, input: z.infer<typeof memoryMaintenanceInput>) {
		const rows = new Map(
			inventory(db, input.conversationId).map((r) => [
				JSON.stringify([r.kind, r.id, r.revision]),
				r,
			]),
		);
		const seen = new Set<string>();
		return input.refs.map((ref) => {
			const key = JSON.stringify([ref.kind, ref.id, ref.revision]);
			const row = rows.get(key);
			if (!row || seen.has(key)) throw new Error("maintenance_conflict");
			seen.add(key);
			return {
				...ref,
				active: row.active,
				changed: row.active !== input.active,
			};
		});
	}
	return {
		list: (conversationId: string) =>
			store.read((db) => ({ items: inventory(db, conversationId) })),
		preview: (raw: unknown) =>
			store.read((db) => ({
				items: plan(db, memoryMaintenanceInput.parse(raw)),
			})),
		apply: (raw: unknown) => {
			const input = memoryMaintenanceInput.parse(raw);
			return store.write((db) => {
				const items = plan(db, input);
				// A restored tendency may depend on State/notes in the same batch, regardless of caller order.
				const changes = input.active
					? [...items].sort(
							(a, b) =>
								Number(a.kind === "tendency") - Number(b.kind === "tendency"),
						)
					: items;
				for (const item of changes) {
					if (!item.changed) continue;
					if (item.kind === "state") {
						const state = states(db).find((s) => s.itemId === item.id)!;
						if (input.active && evidence.usableEvidence(db, state).length === 0)
							throw new Error("maintenance_conflict");
						if (
							input.active &&
							states(db).filter((s) => s.status === "active").length >=
								MAX_ACTIVE_ITEMS
						)
							throw new Error("maintenance_conflict");
						const result = (input.active ? reactivateState : deactivateState)(
							db,
							{
								...deps.scoped(db, "memory.write"),
								clock: { atMs: deps.atMs() },
								itemId: item.id,
								expectedRevision: item.revision,
							},
						);
						if (result.status !== "applied")
							throw new Error("maintenance_conflict");
					} else if (item.kind === "note") {
						const note = deps.continuity
							.ownerItemsInTransaction(db, input.conversationId)
							.find((n) => n.id === item.id)!;
						if (
							input.active &&
							note.sourceMessageIds.some(
								(id) =>
									isBlocked(db, id) ||
									!deps.conversation.messageInTransaction(db, id),
							)
						)
							throw new Error("maintenance_conflict");
						const changed = input.active
							? deps.continuity.restoreByOwnerInTransaction(
									db,
									item.id,
									item.revision,
								)
							: deps.continuity.closeByAgentInTransaction(
									db,
									item.id,
									item.revision,
									"retracted",
								);
						if (!changed) throw new Error("maintenance_conflict");
					} else {
						const tendency = getTendency(db, item.id)!;
						if (input.active) {
							const activeStates = new Set(
								states(db)
									.filter((s) => s.status === "active")
									.map((s) => s.itemId),
							);
							const activeNotes = new Set(
								deps.continuity
									.snapshotInTransaction(db, input.conversationId)
									.items.map((n) => n.id),
							);
							if (
								tendency.evidence.some(
									(e) =>
										!(e.namespace === "state" ? activeStates : activeNotes).has(
											e.id,
										),
								) ||
								listStoredTendencies(db).filter((t) => t.status === "active")
									.length >= 20
							)
								throw new Error("maintenance_conflict");
						}
						if (
							!(input.active ? restoreTendency : retireTendency)(
								db,
								item.id,
								item.revision,
								deps.clock(),
							)
						)
							throw new Error("maintenance_conflict");
					}
				}
				if (items.some((i) => i.changed)) {
					// Reuse the revocation fence: pre-maintenance steward answers must not restore old use.
					bumpForgetSeq(db);
					deps.windows.recordImmediateInTransaction(db, "state_stop", null);
					purgeWindows(db);
				}
				const updated = new Map(
					inventory(db, input.conversationId).map((r) => [
						JSON.stringify([r.kind, r.id]),
						r,
					]),
				);
				return {
					items: items.map((i) => ({
						...i,
						active: input.active,
						revision: updated.get(JSON.stringify([i.kind, i.id]))!.revision,
					})),
				};
			});
		},
	};
}
