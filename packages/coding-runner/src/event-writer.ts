import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { CodingEvent, ExecutionReceipt, ExecutionSpec } from "./contracts";
import type { RunnerConfig } from "./config";
import { addCaptureIssue, observeTerminal } from "./observation";
import type { MessageMetadata } from "./observation";
import { atomicWrite, canonical, digest, lock, totalSize } from "./storage";

/** Persists body and metadata first; only then does the receipt seq (and terminal fact) advance. */
export function createEventWriter(input: {
	config: RunnerConfig;
	path: string;
	spec: ExecutionSpec;
	receipt: ExecutionReceipt;
	maxRunBytes: number;
	save: () => void;
	/** The per-run or global quota rejected a non-essential event. */
	overLimit: () => void;
}) {
	const { config, path, spec, receipt, maxRunBytes } = input;
	let used = 0;
	return function event(
		kind: CodingEvent["kind"],
		text: string,
		essential = false,
		extra: {
			message?: MessageMetadata;
			turnOutcome?: "completed" | "failed";
		} = {},
	) {
		const payloadRef = randomUUID();
		const metadata: CodingEvent = {
			executionId: spec.executionId,
			generation: spec.generation,
			seq: receipt.seq + 1,
			observedAt: Date.now(),
			kind,
			payloadRef,
			payloadDigest: digest(text),
			...(extra.message ? { message: extra.message } : {}),
		};
		const size =
			Buffer.byteLength(text) + Buffer.byteLength(canonical(metadata));
		const release = lock(join(config.spoolRoot, "quota.lock"));
		try {
			if (
				!essential &&
				(used + size > maxRunBytes ||
					totalSize(config.spoolRoot) + size > 200 * 1024 * 1024)
			) {
				input.overLimit();
				return;
			}
			atomicWrite(join(path, "evidence", `${payloadRef}.txt`), text);
			atomicWrite(join(path, "events", `${metadata.seq}.json`), metadata);
			used += size;
			receipt.seq = metadata.seq;
			if (extra.turnOutcome) {
				observeTerminal(receipt.observation, extra.turnOutcome, metadata.seq);
				// Published in the same save as the terminal fact, so no reader sees one without the other.
				if (receipt.observation.turnOutcome === "completed")
					receipt.turnFinished = true;
				// Contradictory terminals are never adopted as a result.
				if (receipt.observation.turnOutcome === "conflict")
					receipt.evidenceComplete = false;
			}
			input.save();
		} finally {
			release();
		}
	};
}
const issueFor: Record<string, Parameters<typeof addCaptureIssue>[1]> = {
	runner_line_limit: "line_limit",
	runner_partial_line: "partial_line",
	runner_output_limit: "output_limit",
	runner_spool_failure: "spool_failure",
	runner_invalid_output: "invalid_event",
	runner_invalid_jsonl: "invalid_event",
	runner_invalid_event: "invalid_event",
	runner_invalid_unicode: "invalid_event",
};
/** Records a capture-integrity fault code on the receipt; other faults only stop the process. */
export function recordCaptureFault(receipt: ExecutionReceipt, code: string) {
	const issue = issueFor[code];
	if (issue) addCaptureIssue(receipt.observation, issue);
}
