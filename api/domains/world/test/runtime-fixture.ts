import { createHash } from "node:crypto";
import type {
	RuntimeLedgerPort,
	RuntimeMeasurement,
	RuntimeVerification,
	SourceKey,
} from "..";
import { SCOPE } from "./fixture";

/**
 * FIXTURE execution ledger. No public host ledger with verified, comparable
 * measurements exists (see contracts/runtime.ts), so this is the ONLY
 * implementation of the port and every test that uses it is fixture-grade.
 */
export const LEDGER_NAMESPACE = "runtime-ledger";

export const keyOf = (id: string): SourceKey => ({
	namespace: LEDGER_NAMESPACE,
	kind: "execution_result",
	id,
	representation: "measurement",
});

type Entry = {
	revision: number;
	verification: RuntimeVerification;
	measurement: RuntimeMeasurement;
	observedAt: number;
	state: "available" | "forgotten" | "retracted";
	principal: string;
	scopeKey: string;
};

/** The conditions of the standard plan: baseline 100 ms (avg, small input), tolerance 2. */
export const BASE: Required<Omit<RuntimeMeasurement, "value" | "window">> & {
	window: { startMs: number; endMs: number };
} = {
	comparisonId: "cmp-1",
	subjectId: "svc-1",
	metric: "latency",
	unit: "ms",
	statistic: "avg",
	configuration: "cfg-a",
	inputProfile: "small",
	baselineRef: "base-1",
	window: { startMs: 1_791_500_000_000, endMs: 1_791_500_600_000 },
};

export function fixtureLedger() {
	const entries = new Map<string, Entry>();
	const digestOf = (id: string, entry: Entry) =>
		// The digest covers the result AND its verification state.
		`sha256:${createHash("sha256")
			.update(
				JSON.stringify([
					id,
					entry.revision,
					entry.verification,
					entry.measurement,
					entry.state,
				]),
			)
			.digest("hex")}`;
	const port: RuntimeLedgerPort = {
		namespace: LEDGER_NAMESPACE,
		readCurrent(_db, _access, key) {
			const entry = entries.get(key.id);
			if (!entry)
				return { status: "missing", source: key, reason: "not_found" };
			if (entry.state !== "available")
				return { status: "missing", source: key, reason: entry.state };
			return {
				status: "available",
				source: key,
				revision: `r${entry.revision}`,
				digest: digestOf(key.id, entry),
				principal: entry.principal,
				scopeKey: entry.scopeKey,
				verification: { state: entry.verification },
				measurement: entry.measurement,
				observedAt: entry.observedAt,
			};
		},
	};
	return {
		port,
		put(
			id: string,
			measurement: RuntimeMeasurement,
			over: Partial<
				Pick<Entry, "verification" | "principal" | "scopeKey">
			> = {},
		) {
			const previous = entries.get(id);
			entries.set(id, {
				revision: (previous?.revision ?? 0) + 1,
				verification: over.verification ?? "verified",
				measurement,
				observedAt: 1_791_500_300_000,
				state: "available",
				principal: over.principal ?? SCOPE.principal,
				scopeKey: over.scopeKey ?? SCOPE.scopeKey,
			});
		},
		/** A correction: a new revision (and so a new digest) of the same result. */
		correct(
			id: string,
			patch: Partial<Entry> & { measurement?: RuntimeMeasurement },
		) {
			const previous = entries.get(id)!;
			entries.set(id, {
				...previous,
				...patch,
				revision: previous.revision + 1,
			});
		},
		forget(id: string) {
			const previous = entries.get(id)!;
			entries.set(id, {
				...previous,
				revision: previous.revision + 1,
				state: "forgotten",
			});
		},
	};
}

/** `m` is the standard plan's conditions with `value`; override single fields to break a condition. */
export const measured = (
	value: number,
	over: Partial<RuntimeMeasurement> = {},
): RuntimeMeasurement => ({ ...BASE, value, ...over });
