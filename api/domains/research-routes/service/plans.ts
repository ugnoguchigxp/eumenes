import type { Database } from "bun:sqlite";
import {
	type LookupHit,
	type LookupProvenance,
	type RequestBinding,
	type RouteLookup,
	type RouteRecipe,
	type RouteState,
	type SearchSpec,
	canonicalJson,
	limits,
	lookupHit,
	lookupProvenance,
	routeRecipe,
	searchSpec,
	sha256,
	ttl,
	validationPolicyVersion,
	type RouteFence,
} from "../contracts";
import * as repo from "../repository";
import {
	type Clock,
	capacityFor,
	deriveState,
	fenceOf,
	liveKey,
	stateTokenOf,
	systemClock,
	versionHealth,
} from "./registry";

export type StoreCandidatesInput = {
	fence: RouteFence;
	provenance: LookupProvenance;
	hits: LookupHit[];
	providerVersion: string;
};
export type StoreCandidatesResult =
	| { kind: "stored"; digest: string }
	| {
			kind: "skipped";
			code:
				| "stale_fence"
				| "disabled"
				| "invalid_provenance"
				| "no_hits"
				| "too_large"
				| "not_fresh_lookup";
	  };
export type ControlResult =
	| {
			kind: "updated";
			key: string;
			state: RouteState;
			stateToken: string;
			generation: number;
	  }
	| { kind: "conflict" }
	| { kind: "not_found" };
export type UseResult = { kind: "updated" } | { kind: "stale" };
export type FailureResult =
	| { kind: "updated"; stateToken: string }
	| { kind: "stale" };

export type PlansOptions = {
	clock?: Clock;
	externalBytes?: (db: Database) => number;
};

export function createPlans(opts: PlansOptions = {}) {
	const clock = opts.clock ?? systemClock;
	const ext = opts.externalBytes ?? (() => 0);

	/** Exact-match lookup. Creates the key row for a new key when the ledger has room. */
	function lookupInTransaction(
		db: Database,
		spec: SearchSpec,
		binding: RequestBinding,
	): RouteLookup {
		const parsed = searchSpec.safeParse(spec);
		if (!parsed.success) return { kind: "unavailable", code: "invalid_spec" };
		const canonical = canonicalJson(parsed.data);
		const key = sha256(canonical);
		if (binding.specDigest !== key)
			return { kind: "unavailable", code: "binding_mismatch" };
		if (binding.validationPolicyVersion !== validationPolicyVersion)
			return { kind: "unavailable", code: "policy_unavailable" };
		const now = clock.now();
		const epoch = repo.getEpoch(db);
		let k = repo.getKey(db, epoch, key);
		if (!k) {
			if (!capacityFor(db, epoch, ext(db)).ok)
				return { kind: "lookup", reason: "capacity", fence: null };
			repo.insertKey(db, {
				epoch,
				key,
				incarnation: clock.id(),
				specJson: canonical,
				keywords: parsed.data.keywords,
				now,
			});
			k = repo.getKey(db, epoch, key)!;
			return { kind: "lookup", reason: "new_key", fence: fenceOf(k) };
		}
		const fence = fenceOf(k);
		if (!k.enabled) return { kind: "disabled" };
		if (k.active_version_id) {
			const { health, version } = versionHealth(db, k, now);
			if (health === "disqualified")
				return { kind: "lookup", reason: "source_failure", fence };
			if (health === "policy_changed")
				return { kind: "lookup", reason: "policy_changed", fence };
			if (health === "expired" || health === "idle_expired")
				return { kind: "lookup", reason: "expired", fence };
			const recipe = routeRecipe.safeParse(JSON.parse(version!.recipe_json));
			if (!recipe.success || recipe.data.specDigest !== key)
				return { kind: "unavailable", code: "recipe_invalid" };
			return {
				kind: "direct",
				versionId: version!.version_id,
				recipe: recipe.data as RouteRecipe,
				fence,
			};
		}
		const c = repo.getCandidate(db, epoch, key);
		if (
			c &&
			c.incarnation === k.incarnation &&
			c.generation === k.generation &&
			now < c.expires_at &&
			now < c.searched_at + ttl.candidateMs
		)
			return { kind: "candidate", candidateDigest: c.digest, fence };
		return {
			kind: "lookup",
			reason:
				k.suspension_reason === "rediscover" ? "rediscover" : "no_candidate",
			fence,
		};
	}

	/** Store a real lookup's hits as a candidate. Never for stale, disabled or capacity-less keys. */
	function storeCandidatesInTransaction(
		db: Database,
		input: StoreCandidatesInput,
	): StoreCandidatesResult {
		const k = liveKey(db, input.fence);
		if (!k) return { kind: "skipped", code: "stale_fence" };
		if (!k.enabled) return { kind: "skipped", code: "disabled" };
		const prov = lookupProvenance.safeParse(input.provenance);
		if (!prov.success) return { kind: "skipped", code: "invalid_provenance" };
		if (prov.data.origin !== "lookup")
			return { kind: "skipped", code: "not_fresh_lookup" };
		const hits = input.hits
			.slice(0, limits.candidateHits)
			.filter((h) => lookupHit.safeParse(h).success);
		if (!hits.length) return { kind: "skipped", code: "no_hits" };
		const hitsJson = JSON.stringify(hits);
		if (new TextEncoder().encode(hitsJson).length > limits.candidateBytes)
			return { kind: "skipped", code: "too_large" };
		const digest = sha256(
			canonicalJson({
				key: k.key,
				incarnation: k.incarnation,
				generation: k.generation,
				hits,
				query: prov.data.query,
				searchedAt: prov.data.searchedAt,
			}),
		);
		repo.putCandidate(db, {
			epoch: k.epoch,
			key: k.key,
			incarnation: k.incarnation,
			generation: k.generation,
			hits_json: hitsJson,
			searched_at: prov.data.searchedAt,
			expires_at: prov.data.searchedAt + ttl.candidateMs,
			provider_version: input.providerVersion,
			digest,
			source_run_id: prov.data.runId,
			source_step_id: prov.data.stepId,
		});
		return { kind: "stored", digest };
	}

	const control = (
		db: Database,
		key: string,
		expectedStateToken: string,
		apply: (k: repo.KeyRow, now: number) => boolean,
	): ControlResult => {
		const epoch = repo.getEpoch(db);
		const k = repo.getKey(db, epoch, key);
		if (!k) return { kind: "not_found" };
		if (stateTokenOf(k) !== expectedStateToken) return { kind: "conflict" };
		const now = clock.now();
		if (!apply(k, now)) return { kind: "conflict" };
		const n = repo.getKey(db, epoch, key)!;
		return {
			kind: "updated",
			key,
			state: deriveState(db, n, now),
			stateToken: stateTokenOf(n),
			generation: n.generation,
		};
	};

	/** Stops use and learning; open drafts are interrupted. Active pointer is kept for display only. */
	function disableInTransaction(
		db: Database,
		input: { key: string; expectedStateToken: string },
	): ControlResult {
		return control(db, input.key, input.expectedStateToken, (k, now) => {
			if (!repo.touchKey(db, k, now, { enabled: 0, generation: true }))
				return false;
			repo.terminateOpenDrafts(
				db,
				k.incarnation,
				"interrupted",
				"route_disabled",
				now,
			);
			return true;
		});
	}
	/** Re-enables and sends the next request back to a real lookup; no active pointer or old candidate survives. */
	function rediscoverInTransaction(
		db: Database,
		input: { key: string; expectedStateToken: string },
	): ControlResult {
		return control(db, input.key, input.expectedStateToken, (k, now) => {
			if (
				!repo.touchKey(db, k, now, {
					enabled: 1,
					active_version_id: null,
					suspension_reason: "rediscover",
					retry_after: null,
					generation: true,
				})
			)
				return false;
			repo.deleteCandidate(db, k.epoch, k.key);
			repo.terminateOpenDrafts(
				db,
				k.incarnation,
				"superseded",
				"rediscover",
				now,
			);
			return true;
		});
	}

	/** Warm use only: refresh lastSuccessAt/idle. Tokens and generation are unchanged. */
	function recordRouteUseInTransaction(
		db: Database,
		input: { versionId: string; fence: RouteFence; usedAt: number },
	): UseResult {
		const k = liveKey(db, input.fence);
		if (!k || !k.enabled || k.active_version_id !== input.versionId)
			return { kind: "stale" };
		if (versionHealth(db, k, input.usedAt).health !== "healthy")
			return { kind: "stale" };
		return repo.markUsed(db, k, input.usedAt, input.usedAt + ttl.idleMs)
			? { kind: "updated" }
			: { kind: "stale" };
	}

	/** Disqualify a failed version (never auto-restored). Sets retry_after; generation unchanged. */
	function markVersionDisqualifiedInTransaction(
		db: Database,
		input: { versionId: string; fence: RouteFence; reason: string },
	): FailureResult {
		const k = liveKey(db, input.fence);
		if (!k || k.active_version_id !== input.versionId) return { kind: "stale" };
		const now = clock.now();
		repo.putHealth(db, input.versionId, now, input.reason);
		repo.touchKey(db, k, now, {
			suspension_reason: input.reason,
			retry_after: now + ttl.retryAfterMs,
		});
		return {
			kind: "updated",
			stateToken: stateTokenOf(repo.getKey(db, k.epoch, k.key)!),
		};
	}

	function getRouteInTransaction(db: Database, key: string) {
		const epoch = repo.getEpoch(db);
		const k = repo.getKey(db, epoch, key);
		if (!k) return null;
		return {
			row: k,
			state: deriveState(db, k, clock.now()),
			stateToken: stateTokenOf(k),
		};
	}

	return {
		lookupInTransaction,
		storeCandidatesInTransaction,
		disableInTransaction,
		rediscoverInTransaction,
		recordRouteUseInTransaction,
		markVersionDisqualifiedInTransaction,
		getRouteInTransaction,
	};
}
export type Plans = ReturnType<typeof createPlans>;
