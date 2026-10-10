import type { Database } from "bun:sqlite";
import { type ScopeRef } from "eumenes-world-model";
import { type WorldApplyResult } from "../contracts";
import {
	allIntakeIds,
	insertIntake,
	listDependents,
	type DependentRow,
} from "../repository/lifecycle";
import { type WorldJournalEntry } from "./world-journal";
import {
	MAX_REGISTRATIONS,
	MAX_TOMBSTONES,
	short,
	StepBlocked,
	rootDigest,
	isValidRoot,
	why,
	chunk,
} from "./lifecycle-shared";
import type { LifecycleCtx } from "./lifecycle-lock";
import type { ForgetOps } from "./lifecycle-forget";

export function createRestoreOps(ctx: LifecycleCtx, forget: ForgetOps) {
	const { store, now, memory, dependentPage, hook, accessFor, worldOp } = ctx;
	const { resumeForgets } = forget;

	// --- restore ------------------------------------------------------------------

	type RegistrationStatus = "registered" | "unknown" | "tombstoned";
	const rank: Record<RegistrationStatus, number> = {
		registered: 0,
		unknown: 1,
		tombstoned: 2,
	};
	const better = (a: RegistrationStatus, b: RegistrationStatus) =>
		rank[a] >= rank[b] ? a : b;

	/** Memory's verdict for each dependency of each dependent, by re-registering through the public API. */
	function classify(
		db: Database,
		scope: ScopeRef,
		rows: readonly DependentRow[],
		epoch: string,
	): Map<string, RegistrationStatus> {
		const access = accessFor(db, scope);
		const status = new Map<string, RegistrationStatus>();
		const set = (key: string, next: RegistrationStatus) =>
			status.set(key, better(status.get(key) ?? "registered", next));
		for (const row of rows) {
			const dependsOn = row.dependsOn.map((d) => ({ type: d.type, id: d.id }));
			const result = memory.register(db, access, now(), scope.scopeKey, [
				{
					providerRef: "eumenes-world",
					externalId: row.externalId,
					dependsOn,
				},
			]);
			if (result.status === "registered") {
				for (const d of row.dependsOn) set(d.key, "registered");
				continue;
			}
			if (result.status === "blocked")
				throw new StepBlocked("MEMORY_UNAVAILABLE");
			if (result.reasonCode === "EXTERNAL_ID_IN_USE") {
				for (const d of row.dependsOn) set(d.key, "unknown");
				continue;
			}
			// Which dependency? Probe each alone with a throwaway dependent, removed again.
			for (const d of row.dependsOn) {
				const probeId = `w1p-${short(`${epoch}\u0000${d.type}\u0000${d.id}`)}-0`;
				const probe = memory.register(db, access, now(), scope.scopeKey, [
					{
						providerRef: "eumenes-world",
						externalId: probeId,
						dependsOn: [{ type: d.type, id: d.id }],
					},
				]);
				if (probe.status === "registered") {
					memory.unregister(db, access, now(), scope.scopeKey, [
						{ providerRef: "eumenes-world", externalId: probeId },
					]);
					set(d.key, "registered");
				} else if (
					probe.status === "rejected" &&
					probe.reasonCode === "TOMBSTONED"
				)
					set(d.key, "tombstoned");
				else if (probe.status === "blocked")
					throw new StepBlocked("MEMORY_UNAVAILABLE");
				else set(d.key, "unknown");
			}
		}
		return status;
	}

	function journalTombstones(
		entries: readonly WorldJournalEntry[],
		scope: ScopeRef,
	) {
		return entries
			.filter(
				(e) => e.principal === scope.principal && e.scopeKey === scope.scopeKey,
			)
			.flatMap((entry) =>
				entry.roots.filter(isValidRoot).map((root) => ({
					ref: { kind: root.kind, id: root.id, revision: root.revision },
					forgetId: entry.forgetId,
					reasonCode: entry.reasonCode,
				})),
			);
	}

	type RestoreOutcome = { ok: true } | { ok: false; reason: string };

	async function restoreScope(
		scope: ScopeRef,
		epoch: string,
		entries: readonly WorldJournalEntry[],
	): Promise<RestoreOutcome> {
		const tok = short(epoch);
		const mustApply = (
			result: WorldApplyResult,
			step: string,
		): string | null =>
			result.status === "applied" || result.status === "no_op"
				? null
				: `${step}_${why(result)}`;
		const begin = await store.write((db) =>
			mustApply(
				worldOp(db, scope, `rs:${tok}:begin`, { kind: "restore.begin" }),
				"BEGIN",
			),
		);
		if (begin) return { ok: false, reason: begin };
		hook("restore_begun");

		// Re-register every recorded World dependent through Memory, page by page.
		// What World was already told per key: a later page may only RAISE it
		// (registered -> unknown -> tombstoned), never be skipped.
		const told = new Map<string, RegistrationStatus>();
		let after: string | null = null;
		for (;;) {
			const page: { next: string | null; error: string | null } =
				await store.write((db) => {
					const rows = listDependents(
						db,
						scope.principal,
						scope.scopeKey,
						after,
						dependentPage,
					);
					if (rows.length === 0) return { next: null, error: null };
					const statuses = classify(db, scope, rows, epoch);
					const fresh = [...statuses].filter(([key, status]) => {
						const previous = told.get(key);
						return previous === undefined || rank[status] > rank[previous];
					});
					for (const group of chunk(fresh, MAX_REGISTRATIONS)) {
						const registrations = group.map(([sourceKey, status]) => ({
							sourceKey,
							status,
						}));
						const error = mustApply(
							worldOp(
								db,
								scope,
								`rs:${tok}:reg:${short(JSON.stringify(registrations))}`,
								{ kind: "restore.register", registrations },
							),
							"REGISTER",
						);
						if (error) throw new StepBlocked(error);
					}
					for (const [key, status] of fresh) told.set(key, status);
					return { next: rows[rows.length - 1]!.externalId, error: null };
				});
			if (page.next === null) break;
			after = page.next;
			hook("restore_registered");
		}

		// Re-apply the newest tombstones from the World journal, in pages.
		const tombstones = journalTombstones(entries, scope);
		const seq = entries[entries.length - 1]?.seq ?? 0;
		const pages =
			tombstones.length === 0 ? [[]] : chunk(tombstones, MAX_TOMBSTONES);
		for (const [index, page] of pages.entries()) {
			const journal = {
				seq,
				final: index === pages.length - 1,
				tombstones: page,
			};
			const error = await store.write((db) =>
				mustApply(
					worldOp(
						db,
						scope,
						`rs:${tok}:rec:${short(JSON.stringify(journal))}`,
						{ kind: "restore.reconcile", journal },
					),
					"RECONCILE",
				),
			);
			if (error) return { ok: false, reason: error };
		}
		hook("restore_reconciled");

		// Forgets of this Scope the restored database still owed: bring them through.
		await resumeForgets(
			(row) =>
				row.principal === scope.principal && row.scopeKey === scope.scopeKey,
		);

		hook("before_restore_finish");
		let drained = 0;
		for (let attempt = 0; attempt < 200; attempt++) {
			const finished = await store.write((db) =>
				worldOp(db, scope, `rs:${tok}:finish`, { kind: "restore.finish" }),
			);
			if (finished.status === "applied" || finished.status === "no_op") {
				hook("restore_finished");
				return { ok: true };
			}
			const pending =
				finished.status === "blocked" &&
				finished.restore?.pendingForget !== undefined
					? finished.restore.pendingForget
					: -1;
			if (
				finished.status === "blocked" &&
				(finished.reasonCode === "FORGET_PENDING" ||
					finished.reasonCode === "JOURNAL_NOT_RECONCILED") &&
				drained < 100
			) {
				// A derived forget drains one chunk per register/reconcile call.
				drained += 1;
				const journal = { seq, final: true, tombstones: [] as never[] };
				const error = await store.write((db) =>
					mustApply(
						worldOp(db, scope, `rs:${tok}:drain:${drained}`, {
							kind: "restore.reconcile",
							journal,
						}),
						"DRAIN",
					),
				);
				if (error) return { ok: false, reason: error };
				void pending;
				continue;
			}
			if (
				finished.status === "blocked" &&
				finished.reasonCode === "FORGET_AWAITING_CONFIRMATION" &&
				attempt < 3
			) {
				await resumeForgets(
					(row) =>
						row.principal === scope.principal &&
						row.scopeKey === scope.scopeKey,
				);
				continue;
			}
			return { ok: false, reason: `FINISH_${why(finished)}` };
		}
		return { ok: false, reason: "FINISH_NOT_CONVERGING" };
	}

	/** Intakes for journal entries a restored database never saw; their World content went through derived forgets. */
	async function adoptJournalEntries(entries: readonly WorldJournalEntry[]) {
		await store.write((db) => {
			const known = allIntakeIds(db);
			for (const entry of entries) {
				if (known.has(entry.forgetId)) continue;
				insertIntake(
					db,
					{
						forgetId: entry.forgetId,
						principal: entry.principal,
						scopeKey: entry.scopeKey,
						memoryForgetId: entry.memoryForgetId,
						memoryFinal: true,
						reasonCode: entry.reasonCode,
						origin: "restored",
						roots: entry.roots.filter(isValidRoot),
						rootsDigest: rootDigest(entry.roots.filter(isValidRoot)),
						state: "world_applied",
						journalSeq: entry.seq,
						journalHash: entry.hash,
					},
					now(),
				);
			}
		});
	}

	return { restoreScope, adoptJournalEntries };
}
export type RestoreOps = ReturnType<typeof createRestoreOps>;
