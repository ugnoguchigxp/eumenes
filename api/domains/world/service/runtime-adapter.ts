import type { Database } from "bun:sqlite";
import type { SourceRef } from "eumenes-memory";
import {
	assessOutcome,
	type Outcome,
	type Prediction,
	type ScopeRef,
} from "eumenes-world-model";
import {
	WORLD_PROVIDER_REF,
	WORLD_RUNTIME_PURPOSE,
	type RuntimeLedgerPort,
	type SourceKey,
} from "../contracts";
import { upsertDependent } from "../repository/lifecycle";
import {
	getRuntimeObservation,
	insertRuntimeObservation,
	listObservedRuntimeObservations,
	listRuntimeObservationsOfPrediction,
	listRuntimeObservationsOfSource,
	maxOutcomeRevision,
	setRuntimeObservationState,
} from "../repository/runtime";
import {
	deleteDependents,
	listDependentIdsByPrefix,
	markReleasePending,
} from "../repository/usage";
import { isMemoryStateItem, sourceKeyOf } from "./inputs";
import { defaultMemoryPort, type MemoryPort } from "./lifecycle-memory";
import {
	MemoryRegistrationRejected,
	externalIdOf,
	planDependents,
	registerWorldDependents,
} from "./memory-adapter";
import {
	missingConditions,
	outcomeOf,
	runtimeOutcomeId,
	short,
	sourceKeyOfRow,
} from "./runtime-outcome";
import type {
	AssessedObservations,
	LedgerVersion,
	ObserveResult,
	PredictionRef,
	ReconcileReport,
	RuntimeObservationOptions,
	RuntimeRefusal,
} from "./runtime-types";
const MAX_SWEEP = 500;

/**
 * Runtime result observation (P4-04). A VERIFIED result of the execution
 * ledger becomes a World Outcome of a quantitative Prediction; nothing else
 * does. The ledger owner keeps owning whether the execution succeeded: World
 * adds only the semantic verdict, via the package's own `assessOutcome`.
 *
 * What is, and is not, an observation:
 *  - Only a snapshot read from the ledger port whose status is `available`,
 *    whose verification state is `verified`, and whose Scope is the request's.
 *    A model's "done" is not a ledger snapshot and has no way in here.
 *  - A verified result missing any comparison condition (comparisonId,
 *    subject, metric, unit, statistic, configuration, input profile, baseline,
 *    window, value) is recorded as INCOMPARABLE with the missing fields as
 *    reason codes; no Outcome is created and nothing is guessed.
 *  - Conditions that are present but differ from the Prediction's make the
 *    Outcome registrable and `assessOutcome` then reports the exact mismatch
 *    (UNIT_MISMATCH, WINDOW_MISMATCH, ...). A different comparisonId is
 *    refused by World itself and recorded as COMPARISON_ID_MISMATCH.
 *
 * Traceability: the host row keeps the ledger result's source key, revision,
 * digest and the Outcome (id, revision) it produced; the Outcome's Memory
 * dependent depends on the ledger source, so Memory's forget reaches it.
 * A repeated notice of the same ledger version is a no-op (the row key and a
 * deterministic operationKey). A later ledger revision becomes the next Outcome
 * revision of the same outcome id, which `assessOutcome` reads as a correction.
 */

export function createRuntimeObservation(options: RuntimeObservationOptions) {
	const { store, world, ledger } = options;
	const purpose = options.purpose ?? WORLD_RUNTIME_PURPOSE;
	const now = options.clock ?? (() => Date.now());
	const memory: MemoryPort = { ...defaultMemoryPort, ...options.memory };
	const register = options.register ?? registerWorldDependents;

	const accessOf = (db: Database, scope: ScopeRef) =>
		world.accessInTransaction(db, {
			access: {
				principal: scope.principal,
				scopeKeys: [scope.scopeKey],
				purpose,
			},
		});

	type Current =
		| {
				ok: true;
				snapshot: Extract<
					ReturnType<RuntimeLedgerPort["readCurrent"]>,
					{ status: "available" }
				>;
				ref: SourceRef;
				version: LedgerVersion;
		  }
		| { ok: false; reasonCode: RuntimeRefusal };

	/** The CURRENT snapshot, accepted only when verified and inside the Scope. */
	function current(db: Database, scope: ScopeRef, key: SourceKey): Current {
		if (key.namespace !== ledger.namespace)
			return { ok: false, reasonCode: "LEDGER_UNAVAILABLE" };
		const snapshot = ledger.readCurrent(db, accessOf(db, scope), key);
		if (snapshot.status !== "available")
			return { ok: false, reasonCode: "LEDGER_UNAVAILABLE" };
		// A result of another Scope looks exactly like a missing one.
		if (
			snapshot.principal !== scope.principal ||
			snapshot.scopeKey !== scope.scopeKey
		)
			return { ok: false, reasonCode: "LEDGER_UNAVAILABLE" };
		if (snapshot.verification.state !== "verified")
			return { ok: false, reasonCode: "NOT_VERIFIED" };
		const sourceKey = sourceKeyOf(key);
		return {
			ok: true,
			snapshot,
			ref: {
				namespace: key.namespace,
				kind: key.kind,
				id: key.id,
				representation: key.representation,
				revision: snapshot.revision,
				digest: snapshot.digest,
			},
			version: {
				sourceKey,
				revision: snapshot.revision,
				digest: snapshot.digest,
			},
		};
	}

	/** Gives an Outcome revision's Memory dependents back; a refusal keeps the host rows for the sweep. */
	function releaseOutcome(
		db: Database,
		scope: ScopeRef,
		outcomeId: string,
		revision: number,
	): void {
		const first = externalIdOf(
			"o",
			scope.principal,
			scope.scopeKey,
			[outcomeId, revision],
			0,
		);
		const ids = listDependentIdsByPrefix(
			db,
			scope.principal,
			scope.scopeKey,
			first.slice(0, first.lastIndexOf("-") + 1),
		);
		if (ids.length === 0) return;
		const savepoint = "world_runtime_release";
		let released = false;
		db.exec(`SAVEPOINT ${savepoint}`);
		try {
			released =
				memory.unregister(
					db,
					accessOf(db, scope),
					now(),
					scope.scopeKey,
					ids.map((externalId) => ({
						providerRef: WORLD_PROVIDER_REF,
						externalId,
					})),
				) === "unregistered";
			db.exec(`RELEASE ${savepoint}`);
		} catch {
			db.exec(`ROLLBACK TO ${savepoint}`);
			db.exec(`RELEASE ${savepoint}`);
		}
		if (released) deleteDependents(db, scope.principal, scope.scopeKey, ids);
		else markReleasePending(db, scope.principal, scope.scopeKey, ids);
	}

	/**
	 * Observes the CURRENT verified version of one ledger result against one
	 * Prediction, in the caller's writer callback. A Memory refusal throws
	 * `MemoryRegistrationRejected`, which rolls the whole callback back (World's
	 * Outcome included); `observe` turns it into a typed result.
	 */
	function observeInTransaction(
		db: Database,
		request: {
			scope: ScopeRef;
			ledger: SourceKey;
			prediction: PredictionRef;
		},
	): ObserveResult {
		const { scope, prediction } = request;
		const read = current(db, scope, request.ledger);
		if (!read.ok) return { status: "refused", reasonCode: read.reasonCode };
		const { snapshot, ref, version } = read;
		const rowKey = {
			principal: scope.principal,
			scopeKey: scope.scopeKey,
			sourceKey: version.sourceKey,
			ledgerRevision: version.revision,
			ledgerDigest: version.digest,
			predictionId: prediction.predictionId,
			predictionRevision: prediction.revision,
		};
		const existing = getRuntimeObservation(db, rowKey);
		if (existing)
			return {
				status: "duplicate",
				state: existing.state,
				outcome:
					existing.outcomeId !== null && existing.outcomeRevision !== null
						? { id: existing.outcomeId, revision: existing.outcomeRevision }
						: null,
				ledger: version,
			};

		const recordIncomparable = (reasons: string[]): ObserveResult => {
			insertRuntimeObservation(db, {
				...rowKey,
				state: "incomparable",
				outcomeId: null,
				outcomeRevision: null,
				reasons,
				observedAtMs: snapshot.observedAt,
				recordedAtMs: now(),
			});
			return { status: "incomparable", reasons, ledger: version };
		};
		const missing = missingConditions(snapshot.measurement);
		if (missing.length > 0) return recordIncomparable(missing);

		const outcomeId = runtimeOutcomeId(scope, version.sourceKey, prediction);
		const revision =
			maxOutcomeRevision(db, scope.principal, scope.scopeKey, outcomeId) + 1;
		const outcome = outcomeOf(snapshot.measurement, {
			outcomeId,
			revision,
			predictionRevision: prediction.revision,
		});
		const result = world.applyInWriter(db, {
			access: {
				principal: scope.principal,
				scopeKeys: [scope.scopeKey],
				purpose,
			},
			scope,
			operationKey: `ro-${short(JSON.stringify([version.sourceKey, version.revision, version.digest, prediction.predictionId, prediction.revision]))}`,
			clock: now(),
			operation: {
				kind: "outcome.register",
				input: { predictionId: prediction.predictionId, outcome },
			},
		});
		if (result.status === "rejected" || result.status === "blocked") {
			// World refuses an Outcome of another comparison: that is a finding about
			// the result, not a failure. Everything else is a refusal with no write.
			if (
				result.status === "rejected" &&
				result.reasonCode === "COMPARISON_MISMATCH"
			)
				return recordIncomparable(["COMPARISON_ID_MISMATCH"]);
			if (
				result.status === "rejected" &&
				result.reasonCode === "INVALID_OUTCOME"
			)
				return recordIncomparable(["CONDITION_INVALID"]);
			return {
				status: result.status,
				reasonCode: result.reasonCode,
				stage: result.stage === "memory" ? "memory" : "world",
			};
		}

		// The Outcome stands on this ledger version: Memory must know it, and
		// forgets/corrections of the ledger source must reach it. Rejection throws.
		const planned = planDependents(
			[{ tag: "o", key: [outcomeId, revision], refs: [ref] }],
			scope,
			{ isStateItem: isMemoryStateItem },
		);
		if ("status" in planned)
			throw new MemoryRegistrationRejected(
				"rejected",
				planned.reasonCode === "DEPENDENCY_LIMIT"
					? "DEPENDENCY_LIMIT"
					: "MEMORY_CONTRACT_REJECTED",
			);
		register(db, {
			access: accessOf(db, scope),
			scopeKey: scope.scopeKey,
			clockMs: now(),
			dependents: planned.dependents,
		});
		for (const dependent of planned.dependents)
			upsertDependent(
				db,
				scope.principal,
				scope.scopeKey,
				dependent.externalId,
				dependent.dependsOn.map((dependency) => ({
					type: dependency.type,
					id: dependency.id,
					key:
						planned.worldKeys.get(`${dependency.type}\u0000${dependency.id}`) ??
						dependency.id,
				})),
			);

		// An earlier ledger version of the same result is now a corrected-away revision.
		for (const old of listRuntimeObservationsOfSource(
			db,
			scope.principal,
			scope.scopeKey,
			version.sourceKey,
			prediction.predictionId,
			prediction.revision,
		))
			if (old.state === "observed")
				setRuntimeObservationState(db, old, "superseded");
		insertRuntimeObservation(db, {
			...rowKey,
			state: "observed",
			outcomeId,
			outcomeRevision: revision,
			observedAtMs: snapshot.observedAt,
			recordedAtMs: now(),
		});
		return {
			status: "observed",
			outcome: { id: outcomeId, revision },
			ledger: version,
		};
	}

	function typedFailure(error: unknown): ObserveResult {
		if (error instanceof MemoryRegistrationRejected)
			return {
				status: error.status,
				reasonCode: error.reasonCode,
				stage: "memory",
			};
		const failure = world.typedFailure(error);
		if (failure.status === "rejected" || failure.status === "blocked")
			return {
				status: failure.status,
				reasonCode: failure.reasonCode,
				stage: failure.stage === "memory" ? "memory" : "world",
			};
		throw error;
	}

	/**
	 * Judges one Prediction against the CURRENT verified ledger versions of its
	 * observations. The observations are rebuilt from the owner's present
	 * snapshot, never from a copy: a corrected, forgotten, retracted or
	 * un-verified result is simply not there (counted as `stale`). The
	 * Prediction is the caller's (the owner of the measurement plan).
	 */
	function assessInTransaction(
		db: Database,
		request: { scope: ScopeRef; prediction: Prediction },
	): AssessedObservations | { status: "invalid"; reasonCode: string } {
		const { scope, prediction } = request;
		const rows = listRuntimeObservationsOfPrediction(
			db,
			scope.principal,
			scope.scopeKey,
			prediction.predictionId,
			prediction.revision,
			["observed", "incomparable"],
			MAX_SWEEP,
		);
		const observations: Outcome[] = [];
		const trace: AssessedObservations["trace"] = [];
		const incomparable: AssessedObservations["incomparable"] = [];
		let stale = 0;
		for (const row of rows) {
			const key = sourceKeyOfRow(row.sourceKey);
			if (!key) {
				stale += 1;
				continue;
			}
			const read = current(db, scope, key);
			const same =
				read.ok &&
				read.version.revision === row.ledgerRevision &&
				read.version.digest === row.ledgerDigest;
			if (!same) {
				stale += 1;
				continue;
			}
			const version: LedgerVersion = {
				sourceKey: row.sourceKey,
				revision: row.ledgerRevision,
				digest: row.ledgerDigest,
			};
			if (
				row.state === "incomparable" ||
				row.outcomeId === null ||
				row.outcomeRevision === null
			) {
				incomparable.push({ ledger: version, reasons: row.reasons });
				continue;
			}
			observations.push(
				outcomeOf(read.snapshot.measurement, {
					outcomeId: row.outcomeId,
					revision: row.outcomeRevision,
					predictionRevision: row.predictionRevision,
				}),
			);
			trace.push({
				outcome: { id: row.outcomeId, revision: row.outcomeRevision },
				ledger: version,
			});
		}
		const assessed = assessOutcome({
			contractVersion: 1,
			scope,
			prediction,
			observations,
		});
		if (!assessed.ok) return { status: "invalid", reasonCode: assessed.code };
		return { assessed: assessed.value, trace, incomparable, stale };
	}

	/**
	 * Re-reads every observed ledger result of the Scope. A later verified
	 * revision is observed as the next Outcome revision (correction); a result the
	 * ledger forgot, retracted or un-verified has its Outcome handed to the forget
	 * procedure (World deletes the measurement, Memory is asked to release it).
	 * Idempotent: safe to call after every ledger change notice and on restart.
	 */
	async function reconcile(scope: ScopeRef): Promise<ReconcileReport> {
		const rows = store.read((db) =>
			listObservedRuntimeObservations(
				db,
				scope.principal,
				scope.scopeKey,
				MAX_SWEEP,
			),
		);
		const report: ReconcileReport = {
			checked: rows.length,
			unchanged: 0,
			corrected: 0,
			withdrawn: 0,
			pending: 0,
		};
		for (const row of rows) {
			const key = sourceKeyOfRow(row.sourceKey);
			if (!key || row.outcomeId === null || row.outcomeRevision === null)
				continue;
			const state = store.read((db) => {
				const read = current(db, scope, key);
				if (!read.ok) {
					const snapshot = ledger.readCurrent(db, accessOf(db, scope), key);
					return {
						kind: "gone" as const,
						forgotten:
							snapshot.status === "missing" && snapshot.reason === "forgotten",
					};
				}
				return read.version.revision === row.ledgerRevision &&
					read.version.digest === row.ledgerDigest
					? { kind: "same" as const }
					: { kind: "changed" as const };
			});
			if (state.kind === "same") {
				report.unchanged += 1;
				continue;
			}
			if (state.kind === "changed") {
				// The next verified revision is a correction of the same Outcome.
				const result = await store
					.write((db) =>
						observeInTransaction(db, {
							scope,
							ledger: key,
							prediction: {
								predictionId: row.predictionId,
								revision: row.predictionRevision,
							},
						}),
					)
					.catch(typedFailure);
				if (result.status === "observed" || result.status === "duplicate")
					report.corrected += 1;
				else if (result.status === "incomparable") report.corrected += 1;
				else report.pending += 1;
				continue;
			}
			// Gone / un-verified: the measurement must not stay in World.
			if (!options.lifecycle) {
				report.pending += 1;
				continue;
			}
			const outcomes = store.read((db) =>
				listRuntimeObservationsOfSource(
					db,
					scope.principal,
					scope.scopeKey,
					row.sourceKey,
					row.predictionId,
					row.predictionRevision,
				).filter((r) => r.outcomeId !== null && r.state !== "withdrawn"),
			);
			const accepted = await options.lifecycle.acceptForget({
				forgetId: `rtf-${short(JSON.stringify([scope.principal, scope.scopeKey, row.sourceKey, row.predictionId, row.predictionRevision, outcomes.map((o) => o.outcomeRevision)]))}`,
				scope,
				reasonCode: state.forgotten ? "SOURCE_FORGOTTEN" : "CORRECTION_APPLIED",
				roots: outcomes.map((o) => ({
					kind: "outcome" as const,
					id: o.outcomeId!,
					revision: o.outcomeRevision!,
				})),
				origin: "request",
			});
			if ("status" in accepted) {
				report.pending += 1;
				continue;
			}
			await store.write((db) => {
				for (const o of outcomes) {
					setRuntimeObservationState(db, o, "withdrawn");
					releaseOutcome(db, scope, o.outcomeId!, o.outcomeRevision!);
				}
			});
			report.withdrawn += 1;
		}
		return report;
	}

	return {
		observeInTransaction,
		/** Own writer callback with typed refusals. */
		async observe(request: {
			scope: ScopeRef;
			ledger: SourceKey;
			prediction: PredictionRef;
		}): Promise<ObserveResult> {
			try {
				return await store.write((db) => observeInTransaction(db, request));
			} catch (error) {
				return typedFailure(error);
			}
		},
		assessInTransaction,
		assess: (request: { scope: ScopeRef; prediction: Prediction }) =>
			store.readSnapshot((db) => assessInTransaction(db, request)),
		reconcile,
	};
}
export type RuntimeObservation = ReturnType<typeof createRuntimeObservation>;
