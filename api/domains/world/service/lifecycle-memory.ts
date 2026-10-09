import type { Database } from "bun:sqlite";
import {
	CONTRACT_VERSIONS,
	type AccessContext,
	type ExternalDependent,
	type ExternalDependentKey,
	type ExternalDeletionState,
	type MemoryChange,
	type RegisterExternalDependentsResult,
} from "eumenes-memory";
import {
	getForgetReceipt,
	listMemoryChanges,
	recordExternalDeletion,
	registerExternalDependents,
	unregisterExternalDependents,
} from "eumenes-memory/sqlite";
import { WORLD_PROVIDER_REF } from "../contracts";

/**
 * The slice of Memory's public sqlite API the World lifecycle uses. Every call
 * runs synchronously on the borrowed writer connection. Tests replace single
 * methods to make Memory reject or be unavailable; production uses
 * `defaultMemoryPort` (the real public API, nothing else).
 */
export type MemoryPort = {
	/** The World dependents (providerRef eumenes-world, with externalId) of a Memory forget. */
	receipt(
		db: Database,
		access: AccessContext,
		forgetId: string,
	):
		| {
				status: "found";
				externals: { externalId: string; state: ExternalDeletionState }[];
		  }
		| { status: "missing" | "not_permitted" };
	/**
	 * Records the state of ONE external deletion. Never the provider-wide form:
	 * externalId is always given. "recorded" means Memory's receipt now shows
	 * exactly that state for that externalId.
	 */
	record(
		db: Database,
		access: AccessContext,
		atMs: number,
		input: {
			forgetId: string;
			externalId: string;
			state: Exclude<ExternalDeletionState, "pending">;
		},
	): "recorded" | "missing" | "not_permitted" | "unknown_provider";
	listChanges(
		db: Database,
		access: AccessContext,
		input: { scopeKey: string; afterSeq: number; limit: number },
	):
		| {
				status: "ok";
				changes: readonly MemoryChange[];
				nextAfterSeq: number;
				hasMore: boolean;
		  }
		| { status: "blocked"; reasonCode: string };
	register(
		db: Database,
		access: AccessContext,
		atMs: number,
		scopeKey: string,
		dependents: readonly ExternalDependent[],
	): RegisterExternalDependentsResult;
	/** "unregistered": Memory removed (or never had) the edges; "blocked": it refused (the rows must be kept). */
	unregister(
		db: Database,
		access: AccessContext,
		atMs: number,
		scopeKey: string,
		keys: readonly ExternalDependentKey[],
	): "unregistered" | "blocked";
};

export const defaultMemoryPort: MemoryPort = {
	receipt(db, access, forgetId) {
		const result = getForgetReceipt(db, {
			contractVersion: CONTRACT_VERSIONS.lifecycle,
			access,
			forgetId,
		});
		if (result.status !== "found") return { status: result.status };
		return {
			status: "found",
			externals: result.receipt.externalDeletions
				.filter(
					(item) =>
						item.providerRef === WORLD_PROVIDER_REF && item.externalId !== null,
				)
				.map((item) => ({
					externalId: item.externalId as string,
					state: item.state,
				})),
		};
	},
	record(db, access, atMs, input) {
		const result = recordExternalDeletion(db, {
			contractVersion: CONTRACT_VERSIONS.lifecycle,
			access,
			clock: { atMs },
			forgetId: input.forgetId,
			providerRef: WORLD_PROVIDER_REF,
			externalId: input.externalId,
			state: input.state,
		});
		if (result.status !== "recorded") return result.status;
		const seen = result.receipt.externalDeletions.find(
			(item) =>
				item.providerRef === WORLD_PROVIDER_REF &&
				item.externalId === input.externalId,
		);
		return seen?.state === input.state ? "recorded" : "unknown_provider";
	},
	listChanges(db, access, input) {
		const result = listMemoryChanges(db, {
			contractVersion: CONTRACT_VERSIONS.external,
			access,
			scopeKeys: [input.scopeKey],
			afterSeq: input.afterSeq,
			limit: input.limit,
		});
		return result.status === "ok"
			? result
			: { status: "blocked", reasonCode: result.reasonCode };
	},
	register(db, access, atMs, scopeKey, dependents) {
		return registerExternalDependents(db, {
			contractVersion: CONTRACT_VERSIONS.external,
			access,
			scopeKey,
			clock: { atMs },
			dependents,
		});
	},
	unregister(db, access, atMs, scopeKey, keys) {
		return unregisterExternalDependents(db, {
			contractVersion: CONTRACT_VERSIONS.external,
			access,
			scopeKey,
			clock: { atMs },
			dependents: keys,
		}).status;
	},
};
