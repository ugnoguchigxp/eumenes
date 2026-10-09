import type { Database } from "bun:sqlite";
import type { AccessContext, SourceRef, SourceState } from "eumenes-memory";
import type { ScopeRef } from "eumenes-world-model";
import type { WorldOperation } from "eumenes-world-model/sqlite";
import type { SourceAdapter, SourceKey } from "../contracts";
import { SourceAccessError } from "./source-adapter";

/**
 * Identity of a source: the JSON array Memory uses as its SourceKey and World
 * uses as its source identity key. Revision and digest are not part of it.
 */
export const sourceKeyOf = (ref: {
	readonly namespace: string;
	readonly kind: string;
	readonly id: string;
	readonly representation?: string;
}): string =>
	JSON.stringify([ref.namespace, ref.kind, ref.id, ref.representation ?? null]);

/**
 * A World input that is a Memory State item rather than a source. The item is
 * scope-checked by Memory itself; every other input is scope-checked by the
 * host SourceAdapter, because Memory does not scope-check source dependencies.
 */
export const MEMORY_STATE_ITEM_NAMESPACE = "memory";
export const MEMORY_STATE_ITEM_KIND = "state_item";
export const isMemoryStateItem = (ref: SourceRef): boolean =>
	ref.namespace === MEMORY_STATE_ITEM_NAMESPACE &&
	ref.kind === MEMORY_STATE_ITEM_KIND;

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Rec)
		: undefined;
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const isRef = (value: unknown): value is SourceRef => {
	const r = rec(value);
	return (
		r !== undefined &&
		typeof r["namespace"] === "string" &&
		typeof r["kind"] === "string" &&
		typeof r["id"] === "string" &&
		typeof r["revision"] === "string" &&
		typeof r["digest"] === "string"
	);
};
const refs = (values: unknown[]): SourceRef[] => values.filter(isRef);

/** First occurrence wins, keyed by source identity. */
export function uniqueByIdentity(values: readonly SourceRef[]): SourceRef[] {
	const seen = new Set<string>();
	const out: SourceRef[] = [];
	for (const ref of values) {
		const key = sourceKeyOf(ref);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(ref);
	}
	return out;
}

/** One derived World object whose inputs Memory must know about. */
export type VersionInputs = {
	/** a: one assertion revision. m: one input manifest. s: the Slice behind one answer run. */
	tag: "a" | "m" | "s";
	/** Identifies the version: [assertionId, revision] or [manifestId]. */
	key: readonly (string | number)[];
	refs: SourceRef[];
};

const evidenceSources = (assertion: unknown): SourceRef[] =>
	refs(list(rec(assertion)?.["evidence"]).map((e) => rec(e)?.["source"]));
const manifestOf = (assertion: unknown): SourceRef[] =>
	refs(list(rec(assertion)?.["inputManifest"]));
/** Evidence plus the input manifest: every source an assertion revision stands on. */
const assertionInputs = (assertion: unknown): SourceRef[] => [
	...manifestOf(assertion),
	...evidenceSources(assertion),
];

/**
 * Every source the operation brings in (the set World demands current states
 * for) and, per derived version, the inputs Memory must record. Mirrors what
 * World itself reads from the operation; malformed shapes yield nothing and
 * World rejects them as INVALID_INPUT.
 */
export function operationInputs(operation: WorldOperation): {
	all: SourceRef[];
	versions: VersionInputs[];
} {
	const versions: VersionInputs[] = [];
	const all: SourceRef[] = [];
	const addVersion = (version: VersionInputs) => {
		const unique = uniqueByIdentity(version.refs);
		if (unique.length === 0) return;
		versions.push({ ...version, refs: unique });
		all.push(...unique);
	};
	switch (operation.kind) {
		case "assertion.register": {
			const a = rec(operation.assertion);
			if (a && typeof a["id"] === "string")
				addVersion({
					tag: "a",
					key: [a["id"], Number(a["revision"])],
					refs: assertionInputs(a),
				});
			break;
		}
		case "assertion.transition": {
			const plan = rec(operation.plan);
			const replacement = rec(operation.replacement);
			const byKey = new Map<string, VersionInputs>();
			const add = (id: unknown, revision: unknown, more: SourceRef[]) => {
				if (typeof id !== "string") return;
				const key = [id, Number(revision)] as const;
				const slot = JSON.stringify(key);
				const found = byKey.get(slot);
				if (found) found.refs.push(...more);
				else byKey.set(slot, { tag: "a", key, refs: [...more] });
			};
			if (replacement)
				add(
					replacement["id"],
					replacement["revision"],
					assertionInputs(replacement),
				);
			// The reason source of a retraction is an input of the next revision.
			if (plan && isRef(plan["reasonSource"]))
				add(plan["id"], plan["nextRevision"], [plan["reasonSource"]]);
			for (const version of byKey.values()) addVersion(version);
			break;
		}
		case "candidate.settle": {
			const manifest = rec(operation.manifest);
			const deps = refs(list(manifest?.["dependencies"]));
			const assertions = list(operation.assertions);
			if (operation.disposition === "applied") {
				if (manifest && typeof manifest["manifestId"] === "string")
					addVersion({ tag: "m", key: [manifest["manifestId"]], refs: deps });
				for (const assertion of assertions) {
					const a = rec(assertion);
					if (a && typeof a["id"] === "string")
						addVersion({
							tag: "a",
							key: [a["id"], Number(a["revision"])],
							refs: [...assertionInputs(a), ...deps],
						});
				}
			} else {
				// World still demands current states for everything the event cites.
				all.push(...deps, ...assertions.flatMap(assertionInputs));
			}
			break;
		}
		default:
			break;
	}
	return { all: uniqueByIdentity(all), versions };
}

export type SourceRefusal = {
	status: "rejected" | "blocked";
	reasonCode:
		| "SOURCE_NOT_AVAILABLE"
		| "SOURCE_REPRESENTATION_REQUIRED"
		| "SOURCE_ADAPTER_MISSING";
};

/**
 * Resolves the CURRENT state of each input through the host SourceAdapter
 * (the scope check). Out-of-scope, unknown and retracted sources are one
 * answer. Strict mode refuses the whole set on the first unresolvable input;
 * lenient mode leaves it out of the snapshot (so World reads it as missing).
 */
export function resolveSources(
	db: Database,
	adapters: ReadonlyMap<string, SourceAdapter>,
	access: AccessContext,
	scope: ScopeRef,
	inputs: readonly SourceRef[],
	mode: "strict" | "lenient",
	isStateItem: (ref: SourceRef) => boolean = isMemoryStateItem,
): { ok: true; states: SourceState[] } | ({ ok: false } & SourceRefusal) {
	const states: SourceState[] = [];
	for (const ref of uniqueByIdentity(inputs)) {
		const refuse = (r: SourceRefusal) =>
			mode === "strict" ? { ok: false as const, ...r } : null;
		const adapter = adapters.get(ref.namespace);
		if (!adapter) {
			const refusal = refuse({
				status: "blocked",
				reasonCode: "SOURCE_ADAPTER_MISSING",
			});
			if (refusal) return refusal;
			continue;
		}
		// The adapter never guesses a representation. State items carry none.
		if (ref.representation === undefined && !isStateItem(ref)) {
			const refusal = refuse({
				status: "rejected",
				reasonCode: "SOURCE_REPRESENTATION_REQUIRED",
			});
			if (refusal) return refusal;
			continue;
		}
		const key: SourceKey = {
			namespace: ref.namespace,
			kind: ref.kind,
			id: ref.id,
			representation: ref.representation ?? "",
		};
		let current: ReturnType<SourceAdapter["resolveCurrent"]> | undefined;
		try {
			current = adapter.resolveCurrent(db, access, key);
		} catch (error) {
			if (!(error instanceof SourceAccessError)) throw error;
		}
		if (
			!current ||
			current.status !== "available" ||
			current.principal !== scope.principal ||
			current.scopeKey !== scope.scopeKey
		) {
			const refusal = refuse({
				status: "rejected",
				reasonCode: "SOURCE_NOT_AVAILABLE",
			});
			if (refusal) return refusal;
			continue;
		}
		states.push({
			namespace: ref.namespace,
			kind: ref.kind,
			id: ref.id,
			...(ref.representation === undefined
				? {}
				: { representation: ref.representation }),
			revision: current.revision,
			digest: current.digest,
			principal: current.principal,
			scopeKey: current.scopeKey,
			status: "available",
		});
	}
	return { ok: true, states };
}

/** Every source an assertion list stands on, for the read path. */
export function assertionSourceRefs(
	assertions: readonly unknown[],
): SourceRef[] {
	return uniqueByIdentity(assertions.flatMap(assertionInputs));
}

/** Source versions a usage receipt names. Untrusted shape: World validates the receipt itself. */
export function receiptSourceRefs(receipt: unknown): SourceRef[] {
	return uniqueByIdentity(refs(list(rec(receipt)?.["sourceVersions"])));
}
