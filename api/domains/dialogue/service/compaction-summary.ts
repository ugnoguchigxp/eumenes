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
import type { Receipt } from "../../inference";
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
import { excludedOnlyIn } from "./memory-refs";
import {
	summaryMaterial,
	summaryRefsValid,
	shortSummaryTime,
} from "./summary-format";
import { replayableCalls } from "./tool-exchange";

const log = getLogger("dialogue");

/** Background queue job kind for pre-computing compacted conversation summaries (`## Summary`). */
export const COMPACT_SUMMARY_KIND = "dialogue.compact_summary";

const COMPACT_TIMEOUT_MS = 45_000;

const compactPayloadSchema = z.object({
	conversationId: z.string(),
	baseCutRevision: z.number().int(),
	// Optional for jobs queued before cut-seq scoping; required on new jobs so repeated compactions never collide.
	baseCutSeq: z.number().int().nonnegative().optional(),
	// Jobs queued before the foreground budget was captured have no budget.
	budget: z
		.object({
			lowTokens: z.number().int().positive(),
			lowUtterances: z.number().int().positive(),
			summaryMaxTokens: z.number().int().positive(),
		})
		.optional(),
});
type CompactPayload = z.infer<typeof compactPayloadSchema>;

type CompactPrepared = {
	conversationId: string;
	baseCutRevision: number;
	baseCutSeq: number;
	coveredFromSeq: number;
	coveredThroughSeq: number;
	sourceRefs: string[];
	coveredSeqs: number[];
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
		window: deps.larm.savedLlmContextWindow?.() ?? REFERENCE_WINDOW_TOKENS,
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
	limits: WorkingLimits,
): boolean {
	if (!deps.larm.captureInTransaction || !deps.larm.executeRequest)
		return false;
	const store = deps.conversation.input;
	const cut = store.cutInTransaction(tx, conversationId);
	if (!cut || cut.due) return false;
	const staged = store.stagedSummaryInTransaction?.(
		tx,
		conversationId,
		cut.revision,
	);
	if (staged && staged.coveredThroughSeq > cut.seq) return false;
	const pending = pendingMessageIdsInTransaction(deps, tx, conversationId);
	const rawShown = store.utterancesAfterInTransaction(
		tx,
		conversationId,
		cut.seq,
	);
	const withheld = excludedOnlyIn(
		deps,
		tx,
		rawShown.flatMap((u) => (u.messageId ? [u.messageId] : [])),
	);
	const shown = rawShown.filter(
		(u) =>
			!(u.messageId && withheld.has(u.messageId)) &&
			!(u.speaker === "user" && u.messageId && pending.has(u.messageId)),
	);
	const users = shown.reduce(
		(sum, u) => sum + (u.speaker === "user" ? 1 : 0),
		0,
	);
	if (users <= limits.softUsers && tokensOf(shown) <= limits.softTokens)
		return false;
	const targetCutSeq = keepNewestCut(shown, cut.seq, limits);
	if (targetCutSeq <= cut.seq) return false;
	try {
		deps.queue.enqueueInTransaction(tx, {
			scope: "dialogue",
			kind: COMPACT_SUMMARY_KIND,
			dedupeKey: `compact:${conversationId}:${cut.revision}:${cut.seq}`,
			payload: {
				conversationId,
				baseCutRevision: cut.revision,
				baseCutSeq: cut.seq,
				budget: {
					lowTokens: limits.lowTokens,
					lowUtterances: limits.lowUtterances,
					summaryMaxTokens: limits.summaryMaxTokens,
				},
			},
			subjectRef: `background:compact:${conversationId}:${cut.revision}:${cut.seq}`,
			lane: "background",
			resourceKey: "inference.llm",
			maxAttempts: 1,
			concurrencyKey: `compact:${conversationId}`,
		});
		return true;
	} catch (error) {
		if (error instanceof Error && error.message === "queue_dedupe_conflict")
			return false;
		throw error;
	}
}

/** Background queue handler that generates and stages compacted `## Summary` rows with strict TOCTOU checks. */
export function createCompactionSummaryHandler(
	deps: DialogueDeps,
): HandlerDefinition<CompactPayload, CompactPrepared, Receipt> {
	function cancelRequest(tx: Database, jobId: string, requestId?: string) {
		const id =
			requestId ??
			deps.larm.requestFor?.(tx, `background:compact:${jobId}`, "llm");
		if (id) deps.larm.cancelRequestsInTransaction?.(tx, [id]);
	}

	return {
		kind: COMPACT_SUMMARY_KIND,
		payloadVersions: [1],
		schema: compactPayloadSchema,
		recovery: "interrupt",
		resourceKey: "inference.llm",
		prepareInTransaction(tx, claim) {
			const { conversationId, baseCutRevision, baseCutSeq } = claim.payload;
			if (!deps.larm.captureInTransaction || !deps.larm.executeRequest)
				return { status: "stale", reason: "inference_unavailable" };
			const store = deps.conversation.input;
			const cut = store.cutInTransaction(tx, conversationId);
			if (
				!cut ||
				cut.revision !== baseCutRevision ||
				(baseCutSeq !== undefined && cut.seq !== baseCutSeq) ||
				cut.due
			)
				return { status: "stale", reason: "cut_changed" };
			const staged = store.stagedSummaryInTransaction?.(
				tx,
				conversationId,
				cut.revision,
			);
			if (staged && staged.coveredThroughSeq > cut.seq)
				return { status: "stale", reason: "already_staged" };
			const pending = pendingMessageIdsInTransaction(deps, tx, conversationId);
			const rawShown = store.utterancesAfterInTransaction(
				tx,
				conversationId,
				cut.seq,
			);
			const withheld = excludedOnlyIn(
				deps,
				tx,
				rawShown.flatMap((u) => (u.messageId ? [u.messageId] : [])),
			);
			const shown = rawShown.filter(
				(u) =>
					!(u.messageId && withheld.has(u.messageId)) &&
					!(u.speaker === "user" && u.messageId && pending.has(u.messageId)),
			);
			const limits =
				claim.payload.budget ?? limitsForConversation(deps, tx, conversationId);
			const targetCutSeq = keepNewestCut(shown, cut.seq, limits);
			const existing = store.activeSummaryInTransaction(tx, conversationId);
			const current =
				existing &&
				summaryRefsValid(deps, tx, conversationId, existing.sourceRefs)
					? existing
					: null;
			const { dropped, sourceRefs } = summaryMaterial(
				deps,
				tx,
				conversationId,
				current,
				shown.filter((u) => u.seq <= targetCutSeq),
			);
			if (!dropped.length)
				return { status: "stale", reason: "nothing_to_compact" };
			if (!summaryRefsValid(deps, tx, conversationId, sourceRefs))
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
					baseCutSeq: cut.seq,
					coveredFromSeq: current?.coveredFromSeq ?? dropped[0]!.seq,
					coveredThroughSeq: targetCutSeq,
					coveredSeqs: dropped.map((u) => u.seq),
					sourceRefs,
					requestId,
					maxTokens: limits.summaryMaxTokens,
					prompt: formatCompactionPrompt(
						current,
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
				AbortSignal.any([signal, AbortSignal.timeout(COMPACT_TIMEOUT_MS)]),
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
			if (typeof receipt.value !== "string" || !receipt.value.trim())
				throw new Error("compact_summary_empty");
			return receipt;
		},
		settleInTransaction(tx, claim, input, outcome) {
			if (outcome.type !== "success" || !input) {
				cancelRequest(tx, claim.jobId, input?.requestId);
				if (outcome.type === "failed")
					log.warn("dialogue.compact_summary_failed", {
						reason: outcome.errorCode,
					});
				return "applied";
			}
			const store = deps.conversation.input;
			const cut = store.cutInTransaction(tx, input.conversationId);
			const reject = () => {
				cancelRequest(tx, claim.jobId, input.requestId);
				return "stale" as const;
			};
			if (
				!cut ||
				cut.revision !== input.baseCutRevision ||
				cut.seq !== input.baseCutSeq ||
				cut.due ||
				!summaryRefsValid(deps, tx, input.conversationId, input.sourceRefs)
			)
				return reject();
			const standing = store.utterancesAfterInTransaction(
				tx,
				input.conversationId,
				cut.seq,
			);
			const expected = new Set(input.coveredSeqs);
			const { dropped } = summaryMaterial(
				deps,
				tx,
				input.conversationId,
				null,
				standing.filter((u) => expected.has(u.seq)),
			);
			const receipt = outcome.result;
			if (
				dropped.length !== expected.size ||
				receipt.requestId !== input.requestId ||
				typeof receipt.value !== "string" ||
				!deps.larm.acceptInTransaction?.(tx, receipt)
			)
				return reject();
			const text = headWithin(receipt.value.trim(), input.maxTokens).text;
			store.saveStagedSummaryInTransaction(tx, {
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
		cancelInTransaction(tx, job) {
			cancelRequest(tx, job.jobId);
		},
	};
}
