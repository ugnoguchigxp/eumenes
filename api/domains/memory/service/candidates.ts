import type { Database } from "bun:sqlite";
import {
	hasMemoryChangesExcludingRun,
	latestMemoryChangeSeq,
	recordCandidate,
	type HostSourceState,
} from "eumenes-memory/sqlite";
import { sha256Hex } from "../../../infrastructure/digest";
import { PRINCIPAL, PROFILE_SCOPE } from "../contracts";
import type {
	CandidateEvidenceInput,
	ChangedExcludingRun,
	ImmediateRejection,
	RecordCandidateInput,
	RecordCandidateOutcome,
} from "../contracts/immediate";
import {
	MAX_EVIDENCE,
	MAX_QUOTE_BYTES,
	MAX_TEXT_CHARS,
	SOURCE_REPRESENTATION,
	byteLength,
	isStateKind,
	refOf,
	type Evidence,
} from "./curation-shared";
import {
	everyItem,
	groundedEvidence,
	guarded,
	rejected,
	type ImmediateDeps,
} from "./immediate-shared";
import { evidenceWindow, locateQuoteSpan, normalizeKey } from "./quote";

/** The namespace an outside note is a source under (a note is not a message: its candidates are external). */
export const NOTE_NAMESPACE = "note";
const NOTE_KIND = "memo";

const hasText = (value: unknown): value is string =>
	typeof value === "string" && value.trim() !== "";

/** The note as a source the library checks a quote against (its text, as of now). */
function noteSource(note: { id: string; text: string }): HostSourceState {
	const digest = sha256Hex(note.text);
	return {
		namespace: NOTE_NAMESPACE,
		kind: NOTE_KIND,
		id: note.id,
		representation: SOURCE_REPRESENTATION,
		revision: `sha256:${digest}`,
		digest,
		principal: PRINCIPAL,
		scopeKey: PROFILE_SCOPE,
		status: "available",
		content: note.text,
		// A note has no place in the conversation: the ordinal is only stored.
		ordinal: 0,
	};
}

function noteEvidence(
	input: Extract<CandidateEvidenceInput, { note: unknown }>,
	hint: string,
):
	| { ok: true; evidence: Evidence; source: HostSourceState }
	| { ok: false; reason: ImmediateRejection } {
	const { note } = input;
	if (!hasText(note?.id) || !hasText(note?.text))
		return { ok: false, reason: "invalid_input" };
	const quote = input.quote ?? null;
	let span: { start: number; end: number } | null = null;
	if (quote !== null && quote.trim() !== "") {
		span = locateQuoteSpan(note.text, quote);
		if (span === null) return { ok: false, reason: "quote_mismatch" };
	}
	const window = evidenceWindow(note.text, span, hint, MAX_QUOTE_BYTES);
	if (window.end <= window.start) return { ok: false, reason: "invalid_input" };
	const source = noteSource(note);
	const startByte = byteLength(note.text.slice(0, window.start));
	return {
		ok: true,
		source,
		evidence: {
			source: refOf(source, {
				startByte,
				endByte:
					startByte + byteLength(note.text.slice(window.start, window.end)),
			}),
			quote: note.text.slice(window.start, window.end),
		},
	};
}

/**
 * The candidates (L1) and the one question the adoption of a generation asks. A candidate is an inference or an
 * observation the user did not state outright: it needs grounds (a user message of the conversation with its quote,
 * or an outside note's text), is never shown to the conversation and is promoted only by the sleeping layer.
 * Whether the information is too sensitive to be noted unasked is the caller's decision.
 */
export function createCandidates(deps: ImmediateDeps) {
	function record(
		db: Database,
		input: RecordCandidateInput,
	): RecordCandidateOutcome {
		if (!deps.ready()) return rejected("memory_unavailable");
		if (
			!hasText(input.conversationId) ||
			!hasText(input.sourceRunId) ||
			input.subject !== "self" ||
			!isStateKind(input.kind) ||
			!hasText(input.text) ||
			[...input.text.trim()].length > MAX_TEXT_CHARS ||
			(input.polarity !== "affirmed" && input.polarity !== "negated") ||
			!Array.isArray(input.evidence) ||
			input.evidence.length === 0 ||
			input.evidence.length > MAX_EVIDENCE
		)
			return rejected("invalid_input");
		const key = normalizeKey(input.semanticKey);
		if (key === null) return rejected("invalid_key");
		const text = input.text.trim();
		return guarded(db, (): RecordCandidateOutcome => {
			// A fact that is being forgotten is not noted anew beside the versions the forget removes.
			if (
				everyItem(db, deps).some(
					(item) =>
						item.excluded === true &&
						item.kind === input.kind &&
						item.subject === "self" &&
						item.semanticKey === key,
				)
			)
				return rejected("forget_pending");
			const evidence: Evidence[] = [];
			const sources = new Map<string, HostSourceState>();
			for (const entry of input.evidence) {
				if ("note" in entry) {
					const built = noteEvidence(entry, text);
					if (!built.ok) return rejected(built.reason);
					evidence.push(built.evidence);
					sources.set(
						`${built.source.namespace}\u0000${built.source.id}`,
						built.source,
					);
					continue;
				}
				if (!hasText(entry.messageId)) return rejected("invalid_input");
				const quote = hasText(entry.quote) ? entry.quote : null;
				const grounded = groundedEvidence(db, deps, {
					conversationId: input.conversationId,
					messageId: entry.messageId,
					quote,
					hint: text,
				});
				if (!grounded.ok) return rejected(grounded.reason);
				evidence.push(grounded.built.evidence);
				sources.set(
					`${grounded.built.source.namespace}\u0000${grounded.built.source.id}`,
					grounded.built.source,
				);
			}
			const result = recordCandidate(db, {
				...deps.scoped(db, "memory.write"),
				clock: { atMs: deps.atMs() },
				kind: input.kind,
				subject: "self",
				semanticKey: key,
				value: { text, polarity: input.polarity },
				evidence: evidence.map((entry) => ({
					source: entry.source,
					quote: entry.quote,
				})),
				sources: [...sources.values()],
				conversationId: input.conversationId,
				sourceRunId: input.sourceRunId,
			});
			if (result.status === "rejected") {
				switch (result.reasonCode) {
					case "QUOTE_MISMATCH":
						return rejected("quote_mismatch");
					case "EVIDENCE_NOT_IN_INPUT":
					case "SOURCE_STALE":
						return rejected("invalid_source");
					case "SOURCE_TOMBSTONED":
						return rejected("source_tombstoned");
					case "EVIDENCE_LIMIT_EXCEEDED":
						return rejected("limit_reached");
					case "SUBJECT_KIND_MISMATCH":
						return rejected("invalid_input");
					default:
						return rejected("conflict");
				}
			}
			if (result.status !== "recorded") return rejected("conflict");
			const { candidate } = result;
			return {
				status: "recorded",
				candidateId: candidate.candidateId,
				created: result.created,
				newObservations: result.newObservations,
				observationCount: candidate.observationCount,
				conversationIds: [...candidate.conversationIds],
				external: candidate.evidence.some(
					(ref) => ref.namespace !== "conversation",
				),
			};
		});
	}

	return {
		record,
		/**
		 * "Did anything but this run change memory after `afterSeq`?" (the adoption check of a generation). `afterSeq` is
		 * the change feed's counter read at the run's prepare (`latestChangeSeqInTransaction`); `latestSeq` of the answer
		 * is the next baseline. A change that names no run (a write without `sourceRunId`, a recovery's re-application)
		 * counts as someone else's.
		 */
		changedExcludingRun(
			db: Database,
			input: { sourceRunId: string; afterSeq: number },
		): ChangedExcludingRun {
			if (!deps.ready()) throw new Error("memory_unavailable");
			if (!hasText(input.sourceRunId) || !Number.isSafeInteger(input.afterSeq))
				throw new Error("invalid_input");
			const result = hasMemoryChangesExcludingRun(db, {
				contractVersion: 1,
				access: deps.scoped(db, "memory.read").access,
				scopeKeys: [PROFILE_SCOPE],
				afterSeq: input.afterSeq,
				sourceRunId: input.sourceRunId,
			});
			if (result.status !== "ok") throw new Error("memory_blocked");
			return {
				changed: result.changed,
				firstSeq: result.firstSeq,
				latestSeq: result.latestSeq,
			};
		},
		/** The change feed's newest counter for the profile: the baseline a run reads at its prepare. */
		latestChangeSeq(db: Database): number {
			if (!deps.ready()) throw new Error("memory_unavailable");
			const result = latestMemoryChangeSeq(db, {
				contractVersion: 1,
				access: deps.scoped(db, "memory.read").access,
				scopeKeys: [PROFILE_SCOPE],
			});
			if (result.status !== "ok") throw new Error("memory_blocked");
			return result.seq;
		},
	};
}
