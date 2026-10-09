import type { Database } from "bun:sqlite";
import {
	type RouteFence,
	type RouteState,
	limits,
	sha256,
	validationPolicyVersion,
} from "../contracts";
import * as repo from "../repository";

export type Clock = { now: () => number; id: () => string };
export const systemClock: Clock = {
	now: () => Date.now(),
	id: () => crypto.randomUUID(),
};

/** Host hash over the identifiers that make a management token stale. */
export const stateTokenOf = (k: repo.KeyRow) =>
	sha256(
		`${k.epoch}:${k.incarnation}:${k.generation}:${k.control_version}:${k.active_version_id ?? ""}`,
	);
export const fenceOf = (k: repo.KeyRow): RouteFence => ({
	key: k.key,
	epoch: k.epoch,
	incarnation: k.incarnation,
	generation: k.generation,
});

/** Does the fence still name the live key row? Epoch is checked against the current epoch. */
export function liveKey(db: Database, fence: RouteFence): repo.KeyRow | null {
	if (fence.epoch !== repo.getEpoch(db)) return null;
	const k = repo.getKey(db, fence.epoch, fence.key);
	return k &&
		k.incarnation === fence.incarnation &&
		k.generation === fence.generation
		? k
		: null;
}

export type Health =
	| "healthy"
	| "disqualified"
	| "expired"
	| "policy_changed"
	| "idle_expired";
/** Active version health at `now`. disqualified > policy_changed > expired. */
export function versionHealth(
	db: Database,
	k: repo.KeyRow,
	now: number,
): { health: Health; version: repo.RevisionRow | null } {
	if (!k.active_version_id) return { health: "healthy", version: null };
	const v = repo.getRevision(db, k.active_version_id);
	if (!v || repo.getHealth(db, v.version_id))
		return { health: "disqualified", version: v };
	if (v.validation_policy_version !== validationPolicyVersion)
		return { health: "policy_changed", version: v };
	if (now >= v.revalidate_at) return { health: "expired", version: v };
	if (k.idle_expires_at !== null && now >= k.idle_expires_at)
		return { health: "idle_expired", version: v };
	return { health: "healthy", version: v };
}

/** Priority: disabled > suspended > expired > active > preparing > unregistered. Never stored. */
export function deriveState(
	db: Database,
	k: repo.KeyRow,
	now: number,
): RouteState {
	if (!k.enabled) return "disabled";
	if (k.active_version_id) {
		const { health } = versionHealth(db, k, now);
		if (health === "disqualified") return "suspended";
		if (health !== "healthy") return "expired";
		return "active";
	}
	return repo.openDraftOf(db, k.incarnation) ? "preparing" : "unregistered";
}

export type Capacity =
	| { ok: true }
	| { ok: false; code: "keys_full" | "bytes_full" };
/** New-key admission. `externalBytes` = learned definition/index bytes held by capabilities. */
export function capacityFor(
	db: Database,
	epoch: number,
	externalBytes = 0,
): Capacity {
	if (repo.countKeys(db, epoch) >= limits.keysMax)
		return { ok: false, code: "keys_full" };
	if (repo.ledgerBytes(db) + externalBytes >= limits.totalBytes)
		return { ok: false, code: "bytes_full" };
	return { ok: true };
}
