import { sha256Hex } from "../../../infrastructure/digest";
import type { Outcome, ScopeRef } from "eumenes-world-model";
import type { RuntimeMeasurement, SourceKey } from "../contracts";
import type { PredictionRef } from "./runtime-types";

export const short = (text: string) => sha256Hex(text).slice(0, 24);

const present = (value: unknown): value is string =>
	typeof value === "string" && value.length > 0;

/** The comparison conditions the ledger did not record, as stable reason codes. */
export function missingConditions(m: RuntimeMeasurement): string[] {
	const missing: string[] = [];
	for (const field of [
		"comparisonId",
		"subjectId",
		"metric",
		"unit",
		"statistic",
		"configuration",
		"inputProfile",
		"baselineRef",
	] as const)
		if (!present(m[field])) missing.push(`CONDITION_MISSING_${field}`);
	const window = m.window;
	if (
		!window ||
		!Number.isSafeInteger(window.startMs) ||
		!Number.isSafeInteger(window.endMs) ||
		window.startMs >= window.endMs
	)
		missing.push("CONDITION_MISSING_window");
	if (typeof m.value !== "number" || !Number.isFinite(m.value))
		missing.push("CONDITION_MISSING_value");
	return missing.sort();
}

/** Outcome id: one per (ledger source, Prediction); ledger corrections raise its revision. */
export const runtimeOutcomeId = (
	scope: ScopeRef,
	sourceKey: string,
	prediction: PredictionRef,
): string =>
	`ro-${short(JSON.stringify([scope.principal, scope.scopeKey, sourceKey, prediction.predictionId]))}`;

export const outcomeOf = (
	m: RuntimeMeasurement,
	ids: { outcomeId: string; revision: number; predictionRevision: number },
): Outcome =>
	({
		kind: "outcome",
		outcomeId: ids.outcomeId,
		revision: ids.revision,
		comparisonId: m.comparisonId,
		predictionRevision: ids.predictionRevision,
		conditions: {
			subjectId: m.subjectId,
			metric: m.metric,
			unit: m.unit,
			statistic: m.statistic,
			configuration: m.configuration,
			inputProfile: m.inputProfile,
		},
		baselineRef: m.baselineRef,
		window: { startMs: m.window!.startMs, endMs: m.window!.endMs },
		value: m.value,
	}) as Outcome;

/** Parses a World source identity key back into the ledger's SourceKey. */
export function sourceKeyOfRow(key: string): SourceKey | null {
	try {
		const parsed = JSON.parse(key) as unknown;
		if (
			Array.isArray(parsed) &&
			parsed.length === 4 &&
			typeof parsed[0] === "string" &&
			typeof parsed[1] === "string" &&
			typeof parsed[2] === "string"
		)
			return {
				namespace: parsed[0],
				kind: parsed[1],
				id: parsed[2],
				representation: typeof parsed[3] === "string" ? parsed[3] : "",
			};
	} catch {
		// fallthrough
	}
	return null;
}
