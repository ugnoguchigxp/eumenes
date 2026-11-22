import type { Database } from "bun:sqlite";
import { z } from "zod";
import {
	REFERENCE_WINDOW_TOKENS,
	estimateTextTokens,
	headWithin,
	planWindow,
} from "../../../infrastructure/context-budget";
import { getLogger } from "../../../infrastructure/logger";
import { systemContext } from "../../../infrastructure/system-context";
import type { ConversationSummary, Utterance } from "../../conversation";
import type { HandlerDefinition } from "../../queue";
import type { DialogueDeps } from "./context";
import {
	conversationSystem,
	keepNewestCut,
	pendingMessageIdsInTransaction,
	tokensOf,
	workingLimits,
	type WorkingLimits,
} from "./conversation-input";
import { dataText } from "./input-text";
import { collectSummarySourceRefs, shortSummaryTime } from "./summary-format";
import { replayableCalls } from "./tool-exchange";

const log = getLogger("dialogue");

/** Background queue job kind for pre-computing compacted conversation summaries (`## Summary`). */
export const COMPACT_SUMMARY_KIND = "dialogue.compact_summary";

const COMPACT_TIMEOUT_MS = 30_000;

const compactPayloadSchema = z.object({
	conversationId: z.string(),
	baseCutRevision: z.number().int(),
});
type CompactPayload = z.infer<typeof compactPayloadSchema>;

type CompactPrepared = {
	conversationId: string;
	baseCutRevision: number;
	coveredFromSeq: number;
	coveredThroughSeq: number;
	sourceRefs: string[];
	requestId: string;
	maxTokens: number;
	prompt: string;
};

function formatCompactionPrompt(
	existing: ConversationSummary | null,
	dropped: readonly Utterance[],
	maxTokens: number,
): string {
	const parts: string[] = [
		`上限: 約${maxTokens}トークン以内。先頭行に「対象範囲: ${shortSummaryTime(dropped[0]!.at)}〜${shortSummaryTime(dropped.at(-1)!.at)}（圧縮済み履歴の要約。詳細は read_history / read_agents で確認可）」を置く。`,
	];
	if (existing?.text) {
		parts.push(`### 既存要約\n${dataText(existing.text)}`);
	}
	const transcript: string[] = [];
	for (const u of dropped) {
		const who = u.speaker === "user" ? "利用者" : "Eumenes";
		transcript.push(`[${shortSummaryTime(u.at)}] ${who}: ${dataText(u.text)}`);
		for (const call of replayableCalls(u)) {
			transcript.push(
				`  [tool:${call.name}] args=${dataText(call.arguments)} result=${dataText(call.result)}`,
			);
		}
	}
	parts.push(`### 今回圧縮する会話・ツール記録\n${transcript.join("\n")}`);
	return parts.join("\n\n");
}

function limitsForConversation(
	deps: DialogueDeps,
	tx: Database,
	conversationId: string,
): WorkingLimits {
	const system = conversationSystem(deps, tx, conversationId);
	const plan = planWindow({
		window: REFERENCE_WINDOW_TOKENS,
		fixed: estimateTextTokens(system),
	});
	return workingLimits(plan);
}

/**
 * Enqueues a single background pre-compaction summary job when the working epoch crosses the Soft threshold.
 * Runs inside the settlement transaction; zero impact on foreground reply latency.
 */
export function maybeEnqueueCompactionInTransaction(
	deps: DialogueDeps,
	tx: Database,
	conversationId: string,
	limits?: WorkingLimits,
): boolean {
	if (!deps.larm.captureInTransaction || !deps.larm.executeRequest)
		return false;
	const store = deps.conversation.input;
	const cut = store.cutInTransaction(tx, conversationId);
	if (!cut || cut.due) return false;
	if (store.stagedSummaryInTransaction?.(tx, conversationId, cut.revision))
		return false;
	const pending = pendingMessageIdsInTransaction(deps, tx, conversationId);
	const shown = store
		.utterancesAfterInTransaction(tx, conversationId, cut.seq)
		.filter(
			(u) => !(u.speaker === "user" && u.messageId && pending.has(u.messageId)),
		);
	const resolved = limits ?? limitsForConversation(deps, tx, conversationId);
	const users = shown.reduce(
		(sum, u) => sum + (u.speaker === "user" ? 1 : 0),
		0,
	);
	if (users <= resolved.softUsers && tokensOf(shown) <= resolved.softTokens)
		return false;
	const targetCutSeq = keepNewestCut(shown, cut.seq, resolved);
	if (targetCutSeq <= cut.seq) return false;
	const nowMs = Date.parse(deps.clock());
	deps.queue.enqueueInTransaction(tx, {
		scope: "dialogue",
		kind: COMPACT_SUMMARY_KIND,
		dedupeKey: `compact:${conversationId}:${cut.revision}`,
		payload: { conversationId, baseCutRevision: cut.revision },
		subjectRef: `background:compact:${conversationId}:${cut.revision}`,
		lane: "background",
		resourceKey: "inference.llm",
		maxAttempts: 1,
		concurrencyKey: `compact:${conversationId}`,
		deadlineAtMs: nowMs + COMPACT_TIMEOUT_MS,
	});
	return true;
}

/** Background queue handler that generates and stages compacted `## Summary` rows with strict TOCTOU checks. */
export function createCompactionSummaryHandler(
	deps: DialogueDeps,
): HandlerDefinition<CompactPayload, CompactPrepared, string> {
	return {
		kind: COMPACT_SUMMARY_KIND,
		payloadVersions: [1],
		schema: compactPayloadSchema,
		recovery: "interrupt",
		resourceKey: "inference.llm",
		prepareInTransaction(tx, claim) {
			const { conversationId, baseCutRevision } = claim.payload;
			if (!deps.larm.captureInTransaction || !deps.larm.executeRequest)
				return { status: "stale", reason: "inference_unavailable" };
			const store = deps.conversation.input;
			const cut = store.cutInTransaction(tx, conversationId);
			if (!cut || cut.revision !== baseCutRevision || cut.due)
				return { status: "stale", reason: "cut_changed" };
			if (store.stagedSummaryInTransaction?.(tx, conversationId, cut.revision))
				return { status: "stale", reason: "already_staged" };
			const pending = pendingMessageIdsInTransaction(deps, tx, conversationId);
			const shown = store
				.utterancesAfterInTransaction(tx, conversationId, cut.seq)
				.filter(
					(u) =>
						!(u.speaker === "user" && u.messageId && pending.has(u.messageId)),
				);
			const limits = limitsForConversation(deps, tx, conversationId);
			const targetCutSeq = keepNewestCut(shown, cut.seq, limits);
			const dropped = shown.filter((u) => u.seq <= targetCutSeq);
			if (!dropped.length)
				return { status: "stale", reason: "nothing_to_compact" };
			const existing =
				store.activeSummaryInTransaction?.(tx, conversationId) ?? null;
			const sourceRefs = collectSummarySourceRefs(deps, tx, existing, dropped);
			if (
				sourceRefs.length &&
				deps.memory &&
				deps.memory.referenceInputs.staleInTransaction(tx, sourceRefs).length >
					0
			)
				return { status: "stale", reason: "sources_forgotten" };
			const requestId = deps.larm.captureInTransaction(
				tx,
				`background:compact:${claim.jobId}`,
				"llm",
				Date.parse(deps.clock()) + COMPACT_TIMEOUT_MS,
			);
			return {
				status: "ready",
				input: {
					conversationId,
					baseCutRevision,
					coveredFromSeq: existing?.coveredFromSeq ?? dropped[0]!.seq,
					coveredThroughSeq: targetCutSeq,
					sourceRefs,
					requestId,
					maxTokens: limits.summaryMaxTokens,
					prompt: formatCompactionPrompt(
						existing,
						dropped,
						limits.summaryMaxTokens,
					),
				},
			};
		},
		async execute(input, { signal }) {
			const system = systemContext(
				"dialogue.contexts.system.compact-summary",
				{},
			);
			const messageIds = input.sourceRefs.filter((ref) => !ref.includes(":"));
			const itemIds = input.sourceRefs
				.filter((ref) => ref.startsWith("memory:"))
				.map((ref) => ref.slice("memory:".length));
			const receipt = await deps.larm.executeRequest!(
				input.requestId,
				[
					{ role: "system", content: system },
					{ role: "user", content: input.prompt },
				],
				signal,
				undefined,
				{
					sessionRole: "auxiliary",
					yields: true,
					outputLimit: Math.min(1500, input.maxTokens + 300),
					...(messageIds.length || itemIds.length
						? { refs: { messageIds, itemIds } }
						: {}),
				},
			);
			const raw = String(receipt.value ?? "").trim();
			if (!raw) throw new Error("compact_summary_empty");
			return headWithin(raw, input.maxTokens).text;
		},
		settleInTransaction(tx, _claim, input, outcome) {
			if (outcome.type !== "success" || !input) {
				if (outcome.type === "failed")
					log.warn("dialogue.compact_summary_failed", {
						reason: outcome.errorCode,
					});
				return "applied";
			}
			const store = deps.conversation.input;
			const cut = store.cutInTransaction(tx, input.conversationId);
			// Strict TOCTOU check: reject if cut moved/bumped (e.g. forgetting) or any source became stale meanwhile.
			if (!cut || cut.revision !== input.baseCutRevision || cut.due)
				return "stale";
			if (
				input.sourceRefs.length &&
				deps.memory &&
				deps.memory.referenceInputs.staleInTransaction(tx, input.sourceRefs)
					.length > 0
			)
				return "stale";
			const standing = store.utterancesAfterInTransaction(
				tx,
				input.conversationId,
				cut.seq,
			);
			const standingIds = new Set(
				standing.map((u) => u.messageId).filter((id): id is string => !!id),
			);
			const blocked = deps.memory
				? new Set(
						deps.memory.blockedMessageIdsOfConversationInTransaction(
							tx,
							input.conversationId,
						),
					)
				: new Set<string>();
			if (
				input.sourceRefs.some((ref) => blocked.has(ref)) ||
				!standing.some((u) => u.seq <= input.coveredThroughSeq)
			)
				return "stale";
			// Also ensure no message in the compacted range was retracted without a cut bump.
			const compacted = standing.filter(
				(u) => u.seq <= input.coveredThroughSeq,
			);
			for (const u of compacted)
				if (u.messageId && !standingIds.has(u.messageId)) return "stale";
			const text = outcome.result;
			store.saveStagedSummaryInTransaction?.(tx, {
				id: deps.id(),
				conversationId: input.conversationId,
				baseCutRevision: input.baseCutRevision,
				coveredFromSeq: input.coveredFromSeq,
				coveredThroughSeq: input.coveredThroughSeq,
				text,
				sourceRefs: input.sourceRefs,
				tokenEstimate: estimateTextTokens(text),
				kind: "llm",
				at: deps.clock(),
			});
			log.info("dialogue.compact_summary_staged", {
				count: input.sourceRefs.length,
				promptTokens: estimateTextTokens(text),
			});
			return "applied";
		},
		cancelInTransaction() {},
	};
}
