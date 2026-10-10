import { z } from "zod";

export const messageMetadataSchema = z
	.strictObject({
		messageKind: z.enum(["commentary", "final_answer", "unknown"]),
		classificationReason: z.enum([
			"explicit_contract",
			"phase_not_provided",
			"phase_unsupported",
			"legacy_unknown",
		]),
		contentPresence: z.enum(["nonempty", "empty"]),
		sourceTruncated: z.union([z.boolean(), z.literal("unknown")]),
		sanitizedBytes: z.number().int().nonnegative().nullable(),
		retainedBytes: z.number().int().nonnegative().nullable(),
	})
	// Only a contract that guarantees the classification may produce a non-unknown kind.
	.refine(
		(v) =>
			v.messageKind === "unknown" ||
			v.classificationReason === "explicit_contract",
		"runner_classification_unconfirmed",
	);
export type MessageMetadata = z.infer<typeof messageMetadataSchema>;
export const captureIssueCodes = [
	"partial_line",
	"line_limit",
	"output_limit",
	"spool_failure",
	"event_gap",
	"digest_mismatch",
	"invalid_event",
] as const;
export type CaptureIssue = (typeof captureIssueCodes)[number];
export const runObservationSchema = z
	.strictObject({
		turnOutcome: z.enum([
			"unconfirmed",
			"completed",
			"failed",
			"cancelled",
			"conflict",
		]),
		terminalEventSeq: z.number().int().positive().nullable(),
		processStarted: z.union([z.boolean(), z.literal("unknown")]),
		captureState: z.enum(["complete", "incomplete", "unknown"]),
		captureIssues: z.array(z.enum(captureIssueCodes)).max(7),
	})
	.refine(
		(v) => (v.turnOutcome === "unconfirmed") === (v.terminalEventSeq === null),
		"runner_terminal_inconsistent",
	);
export type RunObservation = z.infer<typeof runObservationSchema>;
export function initialObservation(): RunObservation {
	return {
		turnOutcome: "unconfirmed",
		terminalEventSeq: null,
		processStarted: false,
		captureState: "complete",
		captureIssues: [],
	};
}
/** Used for receipts written before observations existed: nothing is asserted. */
export function unknownObservation(): RunObservation {
	return {
		...initialObservation(),
		processStarted: "unknown",
		captureState: "unknown",
	};
}
/** A terminal can add knowledge or expose a conflict, never silently replace it. */
export function observeTerminal(
	o: RunObservation,
	outcome: "completed" | "failed",
	seq: number,
) {
	if (o.turnOutcome === "unconfirmed") {
		o.turnOutcome = outcome;
		o.terminalEventSeq = seq;
	} else if (o.turnOutcome !== outcome) o.turnOutcome = "conflict";
}
export function addCaptureIssue(o: RunObservation, code: CaptureIssue) {
	if (!o.captureIssues.includes(code)) o.captureIssues.push(code);
	o.captureState = "incomplete";
}
