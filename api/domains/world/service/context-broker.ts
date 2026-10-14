import type { Database } from "bun:sqlite";
import { sha256Hex } from "../../../infrastructure/digest";
import { CONTRACT_VERSIONS, type SourceRef } from "eumenes-memory";
import { unregisterExternalDependents } from "eumenes-memory/sqlite";
import {
	buildWorldSlice,
	canonicalDigest,
	SLICE_MAX_BYTES,
	toSliceReceipt,
	type Assertion,
	type CanonicalHasher,
	type ProjectionSnapshot,
	type ScopeRef,
	type SliceReceipt,
	type WorldSlice,
} from "eumenes-world-model";
import {
	WORLD_INTERPRETATION_VERSION,
	listEntities,
} from "eumenes-world-model/sqlite";
import worldPackage from "eumenes-world-model/package.json";
import {
	WriterBusyError,
	type SqliteStore,
} from "../../../infrastructure/sqlite";
import {
	CONVERSATION_DEFAULT_PRINCIPAL,
	CONVERSATION_DEFAULT_SCOPE,
} from "../../conversation";
import { goalEpochOf, goalRevisionOf, goalSnapshot } from "../../goals";
import { WORLD_PROVIDER_REF } from "../contracts";
import {
	deleteUsage,
	insertUsage,
	listDependentIdsByPrefix,
	listSurplusUsage,
	type UsageRow,
} from "../repository/usage";
import { upsertDependent } from "../repository/lifecycle";
import {
	CONTEXT_TOTAL_BYTES,
	TOPIC_BLOCK_MAX_BYTES,
	TOPIC_MAX_ENTITIES,
	WORLD_MIN_BYTES,
	allocateContextBudget,
	renderWorldBlock,
	worldBlockBytes,
	type RenderTopic,
} from "./context-render";
import { matchTopicEntities } from "./context-topics";
import { isMemoryStateItem } from "./inputs";
import {
	MemoryRegistrationRejected,
	planDependents,
	registerWorldDependents,
} from "./memory-adapter";
import {
	releaseScopeDependents,
	sliceDependentPrefix,
	sweepReleasePending,
	type UnregisterDependents,
} from "./usage-ledger";
import type { WorldService } from "./world-service";

/**
 * Newest receipts kept per Scope; older ones are released with their Memory
 * dependents. This is also the reach of a LATER forget: a forget invalidates
 * (and unregisters) the answers whose receipts still exist. An answer whose
 * receipt was pruned has no usage row and no Memory dependent any more, so a
 * later forget no longer touches it (the receipt table is audit data; the
 * answer text itself lives in the conversation and is forgotten there). The
 * dependents are therefore kept registered exactly as long as the receipt is.
 */
export const KEEP_USAGE_PER_SCOPE = 500;
/** World contract version the receipt records. */
const CONTRACT_VERSION = 1;
/** Most entities one `listEntities` call returns (the package's own maximum). */
const MAX_LISTED_ENTITIES = 500;
/** Shrink-and-render rounds before the rendered block is declared an overflow. */
const MAX_FIT_ATTEMPTS = 6;

export type ContextPrepareInput = {
	runId: string;
	conversationId: string;
	jobId: string;
	attempt: number;
	generation: number;
	/** Bytes of reference data already fixed for this input (Memory's recall block and the goals layer). */
	reservedBytes: number;
	/**
	 * The wording of this turn the known targets are looked for in: the current user input first, then the
	 * previous exchange (its user input and its answer). Forgotten messages are left out by the caller. Without
	 * any, or when no known target is named, the Slice is the default one.
	 */
	topicTexts?: readonly string[];
	/** UTC epoch ms used as the Slice's asOf (supplied; World never reads a clock). */
	nowMs: number;
};

export type ContextPrepared =
	| { status: "disabled" }
	| { status: "blocked"; reason: string }
	| { status: "ready"; block: string; context: PreparedWorldContext };

export type ContextVerdict =
	| { ok: true }
	/** `retryable`: the check could not run now (writer busy / closing); a new attempt may succeed. */
	| { ok: false; reason: string; retryable?: boolean };

export type ContextSettleInput = {
	runId: string;
	conversationId: string;
	jobId: string;
	attempt: number;
	generation: number;
	/** The inference port's receipt ids; null when it gave none (fixture-grade providers). */
	inference: { requestId: string; attemptId: string } | null;
	nowMs: number;
};

/**
 * Everything fixed at prepare time, deeply frozen. The Slice, its receipt and
 * the dependency manifest are never changed afterwards: settle compares them
 * with the live state and never rebuilds them.
 */
export type PreparedWorldContext = {
	readonly runId: string;
	readonly scope: ScopeRef;
	readonly purpose: string;
	readonly slice: WorldSlice;
	readonly receipt: SliceReceipt;
	/** The adopted goal the Slice was requested for, or null (never invented). */
	readonly goal: { readonly id: string; readonly revision: number } | null;
	/** The Goal scope epoch at prepare; any visible Goal change in the Scope moves it. */
	readonly goalEpoch: number;
	/** Memory external dependents registered for the Slice's inputs. */
	readonly dependentIds: readonly string[];
	/** The known targets the Slice was built for (empty: the default Slice). */
	readonly topicEntityIds: readonly string[];
	readonly budget: {
		readonly totalBytes: number;
		readonly reservedBytes: number;
		readonly worldBytes: number;
		readonly blockBytes: number;
	};
};

export type ContextBrokerOptions = {
	store: SqliteStore;
	world: WorldService;
	/** The Scope a conversation reads from. Default: the conversation default principal/scope. */
	scopeOf?: (conversationId: string) => ScopeRef;
	/** Purpose named in the AccessContext (the conversation SourceAdapter must allow it). */
	purpose?: string;
	hasher?: CanonicalHasher;
	/** The one input budget Memory, Goal and World share. */
	totalBytes?: number;
	/** Host clock for Memory registrations outside prepare (release). Default Date.now. */
	clock?: () => number;
	keepUsagePerScope?: number;
};

const defaultHasher: CanonicalHasher = (bytes) => sha256Hex(bytes);
/** A content-free machine code the queue may persist (`^[a-z][a-z0-9_:]*$`). */
const reasonOf = (code: string) =>
	`world_${code.toLowerCase().replace(/^world_/, "")}`;

function deepFreeze<T>(value: T): T {
	if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value)) deepFreeze(child);
	}
	return value;
}

/** Relations that carry cause and dependency; the topic Slice follows these one step from a named target. */
const TOPIC_RELATIONS: ReadonlySet<string> = new Set([
	"increases",
	"decreases",
	"causes",
	"enables",
	"inhibits",
	"depends_on",
	"part_of",
]);

/**
 * The part of a focused snapshot the topic Slice shows: what is asserted about a named target (its state, and its
 * causal/dependency relations to others), and the claims of others that act on it through such a relation
 * (depth 1). The assertions that dispute a kept one, and those a kept one disputes, stay so a contested claim
 * keeps its refutations.
 */
function topicAssertions(
	assertions: readonly Assertion[],
	focus: ReadonlySet<string>,
): Assertion[] {
	const direct = (assertion: Assertion) => {
		const { payload } = assertion;
		if (payload.kind === "relation")
			return (
				TOPIC_RELATIONS.has(payload.relation) &&
				(focus.has(assertion.subjectId) || focus.has(payload.objectId))
			);
		return focus.has(assertion.subjectId);
	};
	const key = (ref: { id: string; revision: number }) =>
		`${ref.id}\u0000${ref.revision}`;
	const kept = new Set(assertions.filter(direct).map(key));
	const related = new Set<string>();
	for (const assertion of assertions) {
		if (kept.has(key(assertion)))
			for (const target of assertion.contradicts) related.add(key(target));
		else if (assertion.contradicts.some((target) => kept.has(key(target))))
			related.add(key(assertion));
	}
	return assertions.filter(
		(assertion) => kept.has(key(assertion)) || related.has(key(assertion)),
	);
}

/**
 * Context Broker for dialogue: composes the World (and Goal) part of the
 * model input next to the Memory recall, inside the SAME Writer transaction,
 * and later decides whether the answer built on it may be adopted. Thin glue:
 * World semantics stay in `eumenes-world-model`; Memory registration, Goal
 * lookup and the host epochs come from the existing domain adapters.
 */
export function createWorldContextBroker(options: ContextBrokerOptions) {
	const { store, world } = options;
	const hasher = options.hasher ?? defaultHasher;
	const purpose = options.purpose ?? "dialogue.read";
	const totalBytes = options.totalBytes ?? CONTEXT_TOTAL_BYTES;
	const clock = options.clock ?? Date.now;
	const keep = options.keepUsagePerScope ?? KEEP_USAGE_PER_SCOPE;
	const scopeOf =
		options.scopeOf ??
		((): ScopeRef => ({
			principal: CONVERSATION_DEFAULT_PRINCIPAL,
			scopeKey: CONVERSATION_DEFAULT_SCOPE,
		}));
	const requestAccess = (scope: ScopeRef) => ({
		principal: scope.principal,
		scopeKeys: [scope.scopeKey],
		purpose,
	});

	function digestMatches(slice: WorldSlice): boolean {
		const { digest, ...rest } = slice;
		const again = canonicalDigest(rest, hasher);
		return again.ok && again.value === digest;
	}

	/** Memory unregistration for one Scope; "blocked" when Memory refuses. */
	const unregisterFor =
		(db: Database, scope: ScopeRef, nowMs: number): UnregisterDependents =>
		(ids) =>
			unregisterExternalDependents(db, {
				contractVersion: CONTRACT_VERSIONS.external,
				access: world.accessInTransaction(db, {
					access: requestAccess(scope),
				}),
				scopeKey: scope.scopeKey,
				clock: { atMs: nowMs },
				dependents: ids.map((externalId) => ({
					providerRef: WORLD_PROVIDER_REF,
					externalId,
				})),
			}).status;

	/**
	 * Never throws because of Memory: a refusal or a Memory store/contract
	 * error keeps the host rows (marked release_pending) for the retry sweep,
	 * so a dialogue settle or cancel transaction cannot fail on it.
	 */
	function releaseDependents(
		db: Database,
		scope: ScopeRef,
		runId: string,
		nowMs: number,
	) {
		releaseScopeDependents(
			db,
			scope,
			listDependentIdsByPrefix(
				db,
				scope.principal,
				scope.scopeKey,
				sliceDependentPrefix(scope, runId),
			),
			unregisterFor(db, scope, nowMs),
		);
	}

	/**
	 * The known targets this turn's wording names: names and aliases come from `listEntities` (live
	 * entities of the Scope only; merged ones are represented by their representative, forgotten ones are
	 * never listed) and are matched deterministically. A closed gate or a refusal names nothing.
	 */
	function topicEntitiesOf(
		db: Database,
		scope: ScopeRef,
		access: ReturnType<typeof requestAccess>,
		texts: readonly string[] | undefined,
	): string[] {
		if (!texts || texts.every((text) => text.trim() === "")) return [];
		const listed = listEntities(db, {
			contractVersion: 1,
			access: world.accessInTransaction(db, { access }),
			scopeKey: scope.scopeKey,
			limit: MAX_LISTED_ENTITIES,
		});
		if (listed.status !== "ready") return [];
		return matchTopicEntities(listed.entities, texts, TOPIC_MAX_ENTITIES);
	}

	/** Display names of the targets a topic Slice mentions (as subject or relation object), in id order. */
	function topicNames(
		db: Database,
		scope: ScopeRef,
		access: ReturnType<typeof requestAccess>,
		slice: WorldSlice,
	): RenderTopic[] {
		const ids = new Set<string>();
		for (const unit of slice.units) {
			ids.add(unit.conclusion.subjectId);
			if (unit.conclusion.payload.kind === "relation")
				ids.add(unit.conclusion.payload.objectId);
		}
		if (ids.size === 0 || ids.size > MAX_LISTED_ENTITIES) return [];
		const listed = listEntities(db, {
			contractVersion: 1,
			access: world.accessInTransaction(db, { access }),
			scopeKey: scope.scopeKey,
			query: { ids: [...ids].sort() },
			limit: MAX_LISTED_ENTITIES,
		});
		if (listed.status !== "ready") return [];
		return listed.entities.map((entity) => ({
			id: entity.id,
			name: entity.displayName,
		}));
	}

	/**
	 * The one decision "may this Slice still be used?", read-only. It runs at
	 * adoption (inside the Writer transaction) and again just before sending.
	 * A plain re-read of the claim is not enough: the Scope epoch moves on
	 * every change of the stored material (a correction, a new refutation),
	 * and World compares assertion versions, source versions, policy, forget
	 * and restore epochs on top of it.
	 */
	function verdictInTransaction(
		db: Database,
		context: PreparedWorldContext,
	): ContextVerdict {
		if (
			!digestMatches(context.slice) ||
			context.receipt.digest !== context.slice.digest
		)
			return { ok: false, reason: "world_context_tampered" };
		const usage = world.validateUsageInWriter(db, context.receipt, {
			access: requestAccess(context.scope),
			scope: context.scope,
		});
		if (usage.status !== "valid")
			return { ok: false, reason: reasonOf(usage.reasonCode) };
		const access = requestAccess(context.scope);
		if (context.goal !== null) {
			const goal = goalRevisionOf(db, context.goal.id, access);
			if (
				goal === null ||
				goal.status !== "adopted" ||
				goal.revision !== context.goal.revision
			)
				return { ok: false, reason: "world_goal_changed" };
		}
		if (
			goalEpochOf(db, context.scope.principal, context.scope.scopeKey) !==
			context.goalEpoch
		)
			return { ok: false, reason: "world_goal_epoch_changed" };
		return { ok: true };
	}

	return {
		/**
		 * Reads the Slice and Goal snapshots on the writer connection that also
		 * read Memory's recall and registers the Slice's inputs with Memory, all
		 * in the caller's transaction. Nothing is written when the result is not
		 * `ready`. `disabled` means "World contributes nothing" (OFF, schema not
		 * current, nothing to say); `blocked` must end the run, never be dropped.
		 */
		prepareInTransaction(
			db: Database,
			input: ContextPrepareInput,
		): ContextPrepared {
			if (!db.inTransaction)
				throw new Error("world_context_transaction_required");
			if (!world.statusInTransaction(db).usable) return { status: "disabled" };
			const scope = scopeOf(input.conversationId);
			const access = requestAccess(scope);

			// Goals are shown by dialogue's own layer (after L1); the Broker only keeps the top goal as the
			// Slice's goalRef and the goal epoch for the receipt.
			const goals = goalSnapshot(db, access);
			const inScope = goals.goals.filter(
				(goal) => goal.scopeKey === scope.scopeKey,
			);
			const goalEpoch = goalEpochOf(db, scope.principal, scope.scopeKey);
			const top = inScope[0];
			const goalRef =
				top === undefined
					? {}
					: { goalRef: { id: top.goalId, revision: top.revision } };

			/**
			 * Builds the Slice and renders its block. The slice is sized on its UNESCAPED JSON, the model sees
			 * the ESCAPED block (up to 6x per character), so the rendered block is measured and the slice
			 * shrunk (whole units are dropped by buildWorldSlice) until it fits; no room left means
			 * world_overflow. `topic` is set for the topic Slice: its block is capped at TOPIC_BLOCK_MAX_BYTES.
			 */
			const fit = (
				snapshot: ProjectionSnapshot,
				topic: boolean,
			):
				| {
						status: "fitted";
						slice: WorldSlice;
						block: string;
						worldBytes: number;
				  }
				| { status: "disabled" }
				| { status: "blocked"; reason: string } => {
				const allocation = allocateContextBudget({
					totalBytes,
					reservedBytes: input.reservedBytes,
					sliceCapBytes: SLICE_MAX_BYTES,
					...(topic ? { blockCapBytes: TOPIC_BLOCK_MAX_BYTES } : {}),
				});
				if (!allocation.ok)
					return { status: "blocked", reason: "world_budget" };
				let worldBytes = allocation.worldBytes;
				for (let attempt = 0; ; attempt++) {
					if (attempt >= MAX_FIT_ATTEMPTS || worldBytes < WORLD_MIN_BYTES)
						return { status: "blocked", reason: "world_overflow" };
					const built = buildWorldSlice(
						{
							contractVersion: 1,
							snapshot,
							request: { ...goalRef, maxBytes: worldBytes },
						},
						hasher,
					);
					if (!built.ok)
						return { status: "blocked", reason: "world_slice_invalid" };
					if (built.value.status === "disabled") return { status: "disabled" };
					if (built.value.status === "overflow")
						return { status: "blocked", reason: "world_overflow" };
					if (built.value.status === "blocked")
						return {
							status: "blocked",
							reason: reasonOf(built.value.reasonCodes[0] ?? "blocked"),
						};
					// Nothing to say: no usage, no receipt, no input dependency.
					if (built.value.units.length === 0) return { status: "disabled" };
					const rendered = renderWorldBlock(
						built.value,
						topic ? topicNames(db, scope, access, built.value) : [],
					);
					const size = worldBlockBytes(rendered);
					if (size <= allocation.blockLimitBytes)
						return {
							status: "fitted",
							slice: built.value,
							block: rendered,
							worldBytes: allocation.worldBytes,
						};
					worldBytes -= size - allocation.blockLimitBytes;
				}
			};

			// The known targets this turn names: the Slice is built from them when it can be.
			let fitted: ReturnType<typeof fit> | undefined;
			let topicEntityIds: string[] = [];
			const topicIds = topicEntitiesOf(db, scope, access, input.topicTexts);
			if (topicIds.length > 0) {
				const focus = world.readSnapshot(db, {
					access,
					scope,
					asOf: input.nowMs,
					focus: { subjectIds: topicIds, depth: 1 },
				});
				if (focus.status === "ready") {
					const focused = new Set(topicIds);
					const attempt = fit(
						{
							...focus.snapshot,
							assertions: topicAssertions(focus.snapshot.assertions, focused),
						},
						true,
					);
					// A target without anything to say, or one that does not fit its small block, leaves
					// the default Slice (today's behaviour).
					if (attempt.status === "fitted") {
						fitted = attempt;
						topicEntityIds = topicIds;
					}
				}
			}

			if (fitted === undefined) {
				const snapshot = world.readSnapshot(db, {
					access,
					scope,
					asOf: input.nowMs,
				});
				if (snapshot.status === "blocked") {
					if (snapshot.reasonCode === "WORLD_DISABLED")
						return { status: "disabled" };
					if (snapshot.reasonCode === "SCHEMA_INCOMPATIBLE")
						return { status: "disabled" };
					return { status: "blocked", reason: reasonOf(snapshot.reasonCode) };
				}
				if (snapshot.status !== "ready")
					return { status: "blocked", reason: reasonOf(snapshot.reasonCode) };
				fitted = fit(snapshot.snapshot, false);
			}
			if (fitted.status === "disabled") return { status: "disabled" };
			if (fitted.status === "blocked") return fitted;
			const { slice, block } = fitted;

			const dependentIds: string[] = [];
			const planned = planDependents(
				[
					{
						tag: "s",
						key: [input.runId],
						refs: slice.sourceVersions as SourceRef[],
					},
				],
				scope,
				{ isStateItem: isMemoryStateItem },
			);
			if ("status" in planned)
				return { status: "blocked", reason: reasonOf(planned.reasonCode) };
			if (planned.dependents.length > 0) {
				const savepoint = "world_context_register";
				db.exec(`SAVEPOINT ${savepoint}`);
				try {
					registerWorldDependents(db, {
						access: world.accessInTransaction(db, { access }),
						scopeKey: scope.scopeKey,
						clockMs: input.nowMs,
						dependents: planned.dependents,
					});
					for (const dependent of planned.dependents) {
						upsertDependent(
							db,
							scope.principal,
							scope.scopeKey,
							dependent.externalId,
							dependent.dependsOn.map((dependency) => ({
								type: dependency.type,
								id: dependency.id,
								key:
									planned.worldKeys.get(
										`${dependency.type}\u0000${dependency.id}`,
									) ?? dependency.id,
							})),
						);
						dependentIds.push(dependent.externalId);
					}
					db.exec(`RELEASE ${savepoint}`);
				} catch (error) {
					db.exec(`ROLLBACK TO ${savepoint}`);
					db.exec(`RELEASE ${savepoint}`);
					if (error instanceof MemoryRegistrationRejected)
						return { status: "blocked", reason: reasonOf(error.reasonCode) };
					throw error;
				}
			}

			const context: PreparedWorldContext = deepFreeze({
				runId: input.runId,
				scope,
				purpose,
				slice,
				receipt: toSliceReceipt(slice),
				goal:
					top === undefined ? null : { id: top.goalId, revision: top.revision },
				goalEpoch,
				dependentIds,
				topicEntityIds,
				budget: {
					totalBytes,
					reservedBytes: input.reservedBytes,
					worldBytes: fitted.worldBytes,
					blockBytes: worldBlockBytes(block),
				},
			});
			return { status: "ready", block, context };
		},

		/**
		 * Immediately before the model is called. Runs on the Writer so it sees
		 * every committed change; fails closed (no send) when the check cannot
		 * run. It narrows the window, it does not close it: what was already
		 * sent cannot be recalled.
		 */
		async checkBeforeSend(
			context: PreparedWorldContext,
		): Promise<ContextVerdict> {
			try {
				return await store.write((db) => verdictInTransaction(db, context));
			} catch (error) {
				// A busy or closing Writer says nothing about the context: the caller
				// may try again with a fresh attempt. Anything else fails closed.
				const retryable =
					error instanceof WriterBusyError ||
					(error instanceof Error && error.message === "database_closing");
				return retryable
					? { ok: false, reason: "world_check_unavailable", retryable: true }
					: { ok: false, reason: "world_check_unavailable" };
			}
		},

		/** Adoption-time check in the Writer transaction. Read-only. */
		validateInTransaction(
			db: Database,
			_input: ContextSettleInput,
			context: PreparedWorldContext,
		): ContextVerdict {
			return verdictInTransaction(db, context);
		},

		/**
		 * Stores the UsageReceipt. Call it in the same transaction as the answer
		 * message, only after `validateInTransaction` said ok and every other
		 * adoption check passed.
		 */
		recordUsageInTransaction(
			db: Database,
			input: ContextSettleInput,
			context: PreparedWorldContext,
		): void {
			const { slice } = context;
			const row: UsageRow = {
				runId: input.runId,
				principal: context.scope.principal,
				scopeKey: context.scope.scopeKey,
				conversationId: input.conversationId,
				jobId: input.jobId,
				attempt: input.attempt,
				generation: input.generation,
				sliceDigest: slice.digest,
				sliceStatus: slice.status as "ready" | "partial",
				worldScopeEpoch: slice.scopeEpoch,
				policyRevision: slice.policyRevision,
				forgetEpoch: slice.forgetEpoch,
				restoreEpoch: slice.restoreEpoch,
				interpretationVersion:
					slice.interpretationVersion || WORLD_INTERPRETATION_VERSION,
				assertionVersions: [...slice.assertionVersions],
				sourceVersions: [...slice.sourceVersions],
				goal: context.goal === null ? null : { ...context.goal },
				goalEpoch: context.goalEpoch,
				contractVersion: CONTRACT_VERSION,
				packageVersion: worldPackage.version,
				inferenceRequestId: input.inference?.requestId ?? null,
				inferenceAttemptId: input.inference?.attemptId ?? null,
				dependentIds: [...context.dependentIds],
				createdAt: input.nowMs,
			};
			insertUsage(db, row);
			for (const runId of listSurplusUsage(
				db,
				row.principal,
				row.scopeKey,
				keep,
			)) {
				deleteUsage(db, runId);
				releaseDependents(db, context.scope, runId, input.nowMs);
			}
		},

		/**
		 * The run did not adopt (stale, failed, cancelled, expired): drop the
		 * usage record if one exists and release the Slice's input dependencies
		 * from Memory. Safe to call for a run that never used World.
		 */
		releaseInTransaction(
			db: Database,
			runId: string,
			conversationId: string,
		): void {
			const scope = scopeOf(conversationId);
			deleteUsage(db, runId);
			releaseDependents(db, scope, runId, clock());
		},

		/**
		 * Retry sweep: finishes the Memory unregistration of dependents whose
		 * release was refused or failed earlier (host rows marked release_pending).
		 * Idempotent; call it periodically or at startup. Never throws on Memory.
		 */
		sweepPendingReleasesInTransaction(
			db: Database,
			limit = 200,
		): { released: number; stillPending: number } {
			const nowMs = clock();
			return sweepReleasePending(db, limit, (scope) =>
				unregisterFor(db, scope, nowMs),
			);
		},
		sweepPendingReleases(
			limit = 200,
		): Promise<{ released: number; stillPending: number }> {
			return store.write((db) => {
				const nowMs = clock();
				return sweepReleasePending(db, limit, (scope) =>
					unregisterFor(db, scope, nowMs),
				);
			});
		},
	};
}
export type ContextBroker = ReturnType<typeof createWorldContextBroker>;
