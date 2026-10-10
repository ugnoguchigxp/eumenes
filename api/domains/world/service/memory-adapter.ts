import type { Database } from "bun:sqlite";
import { sha256Hex } from "../../../infrastructure/digest";
import {
	CONTRACT_VERSIONS,
	MemoryContractError,
	type AccessContext,
	type ExternalDependencyRef,
	type ExternalDependent,
	type SourceRef,
} from "eumenes-memory";
import {
	MemoryStoreError,
	registerExternalDependents,
} from "eumenes-memory/sqlite";
import {
	WORLD_PROVIDER_REF,
	type MemoryRegistrationSummary,
	type WorldHostReasonCode,
} from "../contracts";
import { isMemoryStateItem, sourceKeyOf, type VersionInputs } from "./inputs";

/** Memory accepts at most 32 dependsOn per dependent and 256 dependents per call. */
export const MAX_DEPENDS_ON = 32;
const MAX_DEPENDENTS_PER_CALL = 256;
/** Memory's identifier limit for a dependency id. */
const MAX_DEPENDENCY_ID_BYTES = 1024;
/** Inputs one World version may have before the host refuses it (never truncated). */
export const DEFAULT_MAX_INPUTS_PER_VERSION = 256;

/**
 * Memory refused (or could not take) the dependent registration. Thrown INSIDE
 * the writer callback so the whole transaction, World write included, rolls
 * back; the service turns it into a typed result at the boundary.
 */
export class MemoryRegistrationRejected extends Error {
	constructor(
		readonly status: "rejected" | "blocked",
		readonly reasonCode: WorldHostReasonCode,
	) {
		super(`world_memory_registration_${reasonCode.toLowerCase()}`);
	}
}

const REJECTION: Record<string, WorldHostReasonCode> = {
	TOMBSTONED: "MEMORY_TOMBSTONED",
	DEPENDENCY_MISSING: "MEMORY_DEPENDENCY_MISSING",
	EXTERNAL_ID_IN_USE: "MEMORY_EXTERNAL_ID_IN_USE",
	SCOPE_NOT_PERMITTED: "MEMORY_SCOPE_NOT_PERMITTED",
};

const utf8 = (text: string) => new TextEncoder().encode(text).length;

/**
 * Opaque Memory externalId of one World version. It is derived from the
 * Scope and the version identity, so a new revision never reuses (and so never
 * replaces) an older revision's dependent. `part` numbers the 32-input slices.
 * Never carries content or the raw ids: 1 letter tag + 40 hex + part < 256 bytes.
 */
export function externalIdOf(
	tag: "a" | "m" | "o" | "s",
	principal: string,
	scopeKey: string,
	key: readonly (string | number)[],
	part: number,
): string {
	const digest = sha256Hex(
		JSON.stringify(["world.v1", tag, principal, scopeKey, key]),
	);
	return `w1${tag}-${digest.slice(0, 40)}-${part}`;
}

export type PlannedDependents = {
	dependents: ExternalDependent[];
	/**
	 * The World source key (sourceIdentityKey) of each dependency, keyed by
	 * `${type}\u0000${id}`. A restore reports registration status by this key.
	 */
	worldKeys: Map<string, string>;
};

export type DependentPlanRefusal = {
	status: "rejected";
	reasonCode: "DEPENDENCY_LIMIT" | "MEMORY_CONTRACT_REJECTED";
};

const dependencyOf = (
	ref: SourceRef,
	isStateItem: (ref: SourceRef) => boolean,
): ExternalDependencyRef =>
	isStateItem(ref)
		? { type: "state_item", id: ref.id }
		: { type: "source", id: sourceKeyOf(ref) };

/**
 * One Memory dependent per 32 inputs of each version, in a stable order. An
 * input set above `maxInputs` (or an id Memory cannot take) is refused as a
 * whole; nothing is ever cut off.
 */
export function planDependents(
	versions: readonly VersionInputs[],
	scope: { principal: string; scopeKey: string },
	options: {
		maxInputs?: number;
		isStateItem?: (ref: SourceRef) => boolean;
	} = {},
): PlannedDependents | DependentPlanRefusal {
	const maxInputs = options.maxInputs ?? DEFAULT_MAX_INPUTS_PER_VERSION;
	const isStateItem = options.isStateItem ?? isMemoryStateItem;
	const dependents: ExternalDependent[] = [];
	const worldKeys = new Map<string, string>();
	for (const version of versions) {
		const unique = new Map<string, ExternalDependencyRef>();
		for (const ref of version.refs) {
			const dependency = dependencyOf(ref, isStateItem);
			if (utf8(dependency.id) > MAX_DEPENDENCY_ID_BYTES)
				return { status: "rejected", reasonCode: "MEMORY_CONTRACT_REJECTED" };
			const slot = `${dependency.type}\u0000${dependency.id}`;
			unique.set(slot, dependency);
			worldKeys.set(slot, sourceKeyOf(ref));
		}
		if (unique.size > maxInputs)
			return { status: "rejected", reasonCode: "DEPENDENCY_LIMIT" };
		const ordered = [...unique.entries()]
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([, dependency]) => dependency);
		for (
			let from = 0, part = 0;
			from < ordered.length;
			from += MAX_DEPENDS_ON
		) {
			dependents.push({
				providerRef: WORLD_PROVIDER_REF,
				externalId: externalIdOf(
					version.tag,
					scope.principal,
					scope.scopeKey,
					version.key,
					part,
				),
				dependsOn: ordered.slice(from, from + MAX_DEPENDS_ON),
			});
			part += 1;
		}
	}
	return { dependents, worldKeys };
}

/**
 * Registers the dependents through Memory's public API in the CURRENT writer
 * transaction. Anything but "registered" throws, so the caller's transaction
 * (including the World operation that just ran) rolls back.
 */
export function registerWorldDependents(
	db: Database,
	input: {
		access: AccessContext;
		scopeKey: string;
		clockMs: number;
		dependents: readonly ExternalDependent[];
	},
): MemoryRegistrationSummary {
	const summary: MemoryRegistrationSummary = {
		dependents: input.dependents.length,
		registered: 0,
		unchanged: 0,
	};
	for (
		let from = 0;
		from < input.dependents.length;
		from += MAX_DEPENDENTS_PER_CALL
	) {
		let result: ReturnType<typeof registerExternalDependents>;
		try {
			result = registerExternalDependents(db, {
				contractVersion: CONTRACT_VERSIONS.external,
				access: input.access,
				scopeKey: input.scopeKey,
				clock: { atMs: input.clockMs },
				dependents: input.dependents.slice(
					from,
					from + MAX_DEPENDENTS_PER_CALL,
				),
			});
		} catch (error) {
			if (error instanceof MemoryContractError)
				throw new MemoryRegistrationRejected(
					"rejected",
					"MEMORY_CONTRACT_REJECTED",
				);
			if (error instanceof MemoryStoreError)
				throw new MemoryRegistrationRejected("blocked", "MEMORY_UNAVAILABLE");
			throw error;
		}
		if (result.status !== "registered")
			throw new MemoryRegistrationRejected(
				result.status,
				REJECTION[result.reasonCode] ?? "MEMORY_CONTRACT_REJECTED",
			);
		summary.registered += result.registered;
		summary.unchanged += result.unchanged;
	}
	return summary;
}
