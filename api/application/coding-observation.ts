import type { SqliteStore } from "../infrastructure/sqlite";
import {
	observationIssueCode,
	type CodingService,
	type ObservationSnapshot,
} from "../domains/coding";
import {
	selectReportMessages,
	type ExecutionObservation,
	type Observation,
	type ObservationReadPort,
} from "../domains/coding-supervision";
import {
	canonicalJSON,
	type MessageMetadata,
} from "../../packages/coding-runner/src/contracts";

/** Per observation, never summed across observations. */
const limits = {
	calls: 4,
	refs: 4,
	bytes: 65536,
	perRef: 65536,
	excerpt: 16000,
};
/** Facts that decide whether evidence was complete; used to detect a change while reading. */
const meaning = (s: ObservationSnapshot) =>
	canonicalJSON({
		id: s.execution.id,
		generation: s.execution.generation,
		epoch: s.execution.authorityEpoch,
		state: s.execution.state,
		run: s.receipt?.observation,
		turn: s.receipt?.turnFinished,
		stopped: s.receipt?.childrenStopped,
		complete: s.receipt?.evidenceComplete,
		exit: s.receipt?.exitCode,
		cursor: s.cursor,
	});
const legacyMetadata = (text: string, total: number): MessageMetadata => ({
	messageKind: "unknown",
	classificationReason: "legacy_unknown",
	contentPresence: text.trim() ? "nonempty" : "empty",
	sourceTruncated: "unknown",
	sanitizedBytes: null,
	retainedBytes: total,
});
function merge(ranges: [number, number][]): [number, number][] {
	const out: [number, number][] = [];
	for (const r of [...ranges].sort((a, b) => a[0] - b[0])) {
		const last = out.at(-1);
		if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
		else out.push([...r]);
	}
	return out;
}
/**
 * Reads adopted facts, then a bounded part of the stored public text through coding.readEvidence.
 * Nothing here talks to the runner for process control, and nothing is stored from this module.
 */
export function codingObservationReader(
	store: SqliteStore,
	coding: CodingService,
): ObservationReadPort {
	const snapshot = (taskId: string) =>
		store.readSnapshot((db) =>
			coding.observationSnapshotInTransaction(db, taskId),
		);
	return {
		async inspect(taskId, signal, focus): Promise<Observation> {
			signal.throwIfAborted();
			const before = snapshot(taskId);
			const { execution: e, receipt: r } = before;
			const limitations = new Set<string>();
			if (before.legacy) limitations.add("legacy_source_unknown");
			const known = before.messages.map((m) => ({
				seq: m.seq,
				ref: m.payloadRef,
				metadata: m.message ?? legacyMetadata("", 0),
				event: m,
			}));
			const picked = selectReportMessages(known);
			const all = [
				...(before.fileChange
					? [{ event: before.fileChange, kind: "snapshot" as const }]
					: []),
				...picked.chosen.map((m) => ({
					event: known.find((k) => k.seq === m.seq)!.event,
					kind: "message" as const,
				})),
			].slice(0, limits.refs);
			// A focused read still reads the snapshot and other messages; only its own reference resumes at the offset.
			const targets = all;
			let remaining = limits.bytes,
				calls = 0,
				notFull = !r || before.cursor !== r.seq;
			let excerpt = "",
				snapshotHash: string | null = null;
			const coverage: ExecutionObservation["coverage"] = [],
				refs: string[] = [],
				adopted: ExecutionObservation["messages"] = [];
			const note = (metadata: MessageMetadata) => {
				if (metadata.sourceTruncated === true)
					limitations.add("source_truncated");
				if (metadata.sourceTruncated === "unknown")
					limitations.add("legacy_source_unknown");
				if (metadata.messageKind === "unknown")
					limitations.add("classification_unknown");
			};
			for (const t of targets) {
				const ev = t.event;
				// Speech facts come from adopted metadata, so a failed text read does not change them.
				if (t.kind === "message" && ev.message) {
					adopted.push({
						seq: ev.seq,
						ref: ev.payloadRef,
						digest: ev.payloadDigest,
						metadata: ev.message,
					});
					note(ev.message);
				}
				const start = focus && focus.ref === ev.payloadRef ? focus.offset : 0;
				let offset = start,
					text = "",
					total: number | null = null;
				const ranges: [number, number][] = [];
				const cap = Math.min(limits.perRef, remaining);
				let used = 0;
				while (
					calls < limits.calls &&
					used < cap &&
					(total === null || offset < total)
				) {
					signal.throwIfAborted();
					let chunk: Awaited<ReturnType<typeof coding.readEvidence>>;
					try {
						chunk = await coding.readEvidence(
							e.id,
							ev.payloadRef,
							offset,
							Math.max(4, Math.min(cap - used, 65536)),
							signal,
						);
					} catch (error) {
						signal.throwIfAborted();
						// The snapshot decides what verification still applies: a guess is worse than a retry.
						if (t.kind === "snapshot") throw error;
						// Not being able to read text is a limit of this observation; wrong text is not.
						if (error instanceof Error && error.message.includes("evidence"))
							throw error;
						limitations.add("evidence_unreadable");
						break;
					}
					calls++;
					// A different digest or length means this is not the evidence we adopted.
					if (
						chunk.digest !== ev.payloadDigest ||
						(total !== null && total !== chunk.totalBytes) ||
						chunk.nextOffset < offset ||
						Buffer.byteLength(chunk.text) !== chunk.nextOffset - offset
					)
						throw new Error("runner_evidence_digest_conflict");
					total = chunk.totalBytes;
					if (chunk.nextOffset === offset && offset < total)
						throw new Error("coding_observation_stale");
					ranges.push([offset, chunk.nextOffset]);
					used += chunk.nextOffset - offset;
					remaining -= chunk.nextOffset - offset;
					offset = chunk.nextOffset;
					text += chunk.text;
				}
				if (total === null) {
					notFull = true;
					continue;
				}
				const merged = merge(ranges);
				coverage.push({
					ref: ev.payloadRef,
					digest: ev.payloadDigest,
					totalBytes: total,
					ranges: merged.slice(0, 8),
				});
				refs.push(ev.payloadRef);
				const full =
					start === 0 &&
					merged.length === 1 &&
					merged[0]![0] === 0 &&
					merged[0]![1] === total;
				if (!full) notFull = true;
				if (t.kind === "message") {
					const metadata = ev.message ?? legacyMetadata(text, total);
					if (!ev.message) {
						adopted.push({
							seq: ev.seq,
							ref: ev.payloadRef,
							digest: ev.payloadDigest,
							metadata,
						});
						note(metadata);
					}
					excerpt += `[${metadata.messageKind} #${ev.seq}${full ? "" : " 一部"}]\n${text}\n`;
				} else if (full) {
					try {
						const v: unknown = JSON.parse(text);
						if (
							v &&
							typeof v === "object" &&
							"finalSnapshotDigest" in v &&
							typeof v.finalSnapshotDigest === "string" &&
							/^[a-f0-9]{64}$/.test(v.finalSnapshotDigest)
						)
							snapshotHash = v.finalSnapshotDigest;
					} catch {
						/* A file-change announcement without a receipt carries no snapshot. */
					}
				}
			}
			// Adopted facts must not have moved while the text was being read.
			if (meaning(before) !== meaning(snapshot(taskId)))
				throw new Error("coding_observation_stale");
			signal.throwIfAborted();
			const excerptTruncated = excerpt.length > limits.excerpt;
			if (excerptTruncated) limitations.add("context_excerpt_truncated");
			if (notFull) limitations.add("not_fully_observed");
			if (picked.omitted > 0 || before.messageCount > before.messages.length)
				limitations.add("messages_omitted");
			const run = e.observation;
			const presence = before.messages.map(
				(m) => m.message?.contentPresence ?? null,
			);
			const allKnown = before.messageCount <= before.messages.length;
			const publicReport: ExecutionObservation["publicReport"] =
				presence.includes("nonempty")
					? "nonempty_observed"
					: before.messageCount === 0 && !notFull
						? "none_observed"
						: allKnown &&
							  presence.length > 0 &&
							  presence.every((p) => p === "empty")
							? "empty_only"
							: "not_fully_observed";
			const hasFinal = adopted.some(
				(m) => m.metadata.messageKind === "final_answer",
			);
			// exec 0.155.1 gives no way to tell which message is final.
			const finalReport: ExecutionObservation["finalReport"] = hasFinal
				? "observed"
				: "unidentifiable";
			const facts = [
				`turn終端: ${run.turnOutcome}`,
				`process: ${e.state} / 停止確認: ${e.childrenStopped}`,
				`採取: ${run.captureState}${run.captureIssues.length ? ` (${run.captureIssues.join(",")})` : ""}`,
				`報告: ${publicReport} / final: ${finalReport}`,
				...[...limitations].slice(0, 3).map((v) => `制約: ${v}`),
			];
			return {
				executionId: e.id,
				eventSeq: before.cursor,
				sessionId: r?.sessionId ?? null,
				snapshotHash,
				turnFinished: e.turnFinished,
				childrenStopped: e.childrenStopped,
				evidenceComplete: e.evidenceComplete,
				exitCode: e.exitCode,
				question: null,
				evidenceRefs: refs,
				facts,
				excerpt: excerpt.slice(0, limits.excerpt),
				details: {
					run,
					processState: e.state,
					messages: adopted,
					publicReport,
					finalReport,
					limitations: [...limitations],
					issue: null,
					coverage,
					excerptTruncated,
				},
			};
		},
	};
}
/** For a failed observation: the code and the position of the last adopted fact. */
export function observationFailure(
	store: SqliteStore,
	coding: CodingService,
	taskId: string,
	error: unknown,
	generation: number,
	authorityEpoch: number,
) {
	let executionId: string | null = null,
		lastCursor: number | null = null;
	try {
		const e = store.readSnapshot((db) =>
			coding.latestInTransaction(db, taskId),
		);
		executionId = e?.id ?? null;
		lastCursor = e?.cursor ?? null;
	} catch {
		/* position is optional */
	}
	return {
		code: observationIssueCode(error),
		generation,
		authorityEpoch,
		executionId,
		lastCursor,
	};
}
