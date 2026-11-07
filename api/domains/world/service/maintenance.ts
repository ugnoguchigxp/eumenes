import { z } from "zod";
import { buildProjection } from "eumenes-world-model";
import { sha256Hex } from "../../../infrastructure/digest";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { WorldDocumentScope } from "../contracts/documents";
import {
	excludedRefs,
	setExcluded,
	storedDocuments,
} from "../repository/working-set";
import type { WorldService } from "./world-service";

export const worldMaintenanceInput = z.strictObject({
	active: z.boolean(),
	refs: z
		.array(
			z.strictObject({
				kind: z.enum(["claim", "document"]),
				id: z.string().min(1).max(240),
				revision: z.string().min(1).max(200),
			}),
		)
		.min(1)
		.max(2500),
});

/** Owner-selected IDs only. No semantic selection and no changes to the source material. */
export function createWorldMaintenance(
	store: SqliteStore,
	world?: WorldService,
	readPurpose = "dialogue.read",
) {
	function inventory(
		db: Parameters<WorldService["readSnapshot"]>[0],
		scope: WorldDocumentScope,
	) {
		const excluded = new Set(
			excludedRefs(db, scope).map((r) =>
				JSON.stringify([r.kind, r.id, r.revision]),
			),
		);
		const documents = storedDocuments(db, scope);
		if (documents.length > 2500) throw new Error("maintenance_incomplete");
		const read = world?.readStoredSnapshot(db, {
			access: {
				principal: scope.principal,
				scopeKeys: [scope.scopeKey],
				purpose: readPurpose,
			},
			scope,
			asOf: Date.now(),
		});
		if (
			world &&
			(read?.status !== "ready" ||
				read.coverage.partial ||
				!read.snapshot.complete)
		)
			throw new Error("maintenance_incomplete");
		const projection =
			read?.status === "ready"
				? buildProjection(
						{ contractVersion: 1, snapshot: read.snapshot },
						sha256Hex,
					)
				: undefined;
		if (projection && !projection.ok) throw new Error("maintenance_incomplete");
		return [
			...documents.map((d) => ({ kind: "document" as const, ...d })),
			...(projection?.ok
				? projection.value.entries.map((a) => ({
						kind: "claim" as const,
						id: a.id,
						revision: String(a.revision),
						title: a.predicate,
					}))
				: []),
		].map((r) => ({
			...r,
			active: !excluded.has(JSON.stringify([r.kind, r.id, r.revision])),
		}));
	}
	function plan(
		db: Parameters<WorldService["readSnapshot"]>[0],
		scope: WorldDocumentScope,
		input: z.infer<typeof worldMaintenanceInput>,
	) {
		const rows = new Map(
			inventory(db, scope).map((r) => [
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
		list: (scope: WorldDocumentScope) =>
			store.readSnapshot((db) => ({ items: inventory(db, scope) })),
		preview: (scope: WorldDocumentScope, raw: unknown) =>
			store.readSnapshot((db) => ({
				items: plan(db, scope, worldMaintenanceInput.parse(raw)),
			})),
		apply: (scope: WorldDocumentScope, raw: unknown) => {
			const input = worldMaintenanceInput.parse(raw);
			return store.write((db) => {
				const items = plan(db, scope, input);
				for (const item of items)
					if (item.changed) setExcluded(db, scope, item, !input.active);
				return {
					items: items.map((item) => ({ ...item, active: input.active })),
				};
			});
		},
	};
}
