import type { Database } from "bun:sqlite";
import {
	estimateTextTokens,
	headWithin,
	type WindowPlan,
} from "../../../infrastructure/context-budget";
import { jstDisplay } from "../../../infrastructure/jst-time";
import type {
	ConversationCut,
	ConversationSummary,
	Utterance,
} from "../../conversation";
import type { DialogueDeps } from "./context";
import { lineText } from "./input-text";
import { inheritedHistorySources } from "./history-sources";
import { excludedOnlyIn } from "./memory-refs";
import { callsMark, replayableCalls } from "./tool-exchange";

const MECHANICAL_MAX_TOKENS = 400;

/** Default legacy cut bounds when no window-derived `WorkingLimits` are passed. */
export const RECENT = {
	/** One utterance shows at most this much; the rest is cut with `…`. */
	utteranceTokens: 120,
	hardCount: 20,
	hardTokens: 4000,
	/** A fixed-rule cut keeps this many newest utterances (starting with the agent's). */
	keep: 4,
	/** A silence this long before an input starts the recent conversation again. */
	gapMs: 30 * 60 * 1000,
} as const;

/** The bounds of the working conversation between two cuts (`workingLimits`). */
export type WorkingLimits = {
	hardTokens: number;
	hardUsers: number;
	softTokens: number;
	softUsers: number;
	lowTokens: number;
	lowUtterances: number;
	summaryMaxTokens: number;
};

/**
 * Size-first bounds (spec conversation-input-size-budget-design-2026-11-28, section 7): the conversation keeps a few
 * exchanges and a short summary, and what is older is read again with the read tools. The summary is prepared once
 * more than three exchanges are held and a cut comes once more than five are. A prepared summary covers what was
 * held when it was prepared less the newest two exchanges, so a cut that adopts it leaves those and what came
 * since: the conversation holds three to six exchanges.
 */
const HISTORY = {
	hardUsers: 5,
	softUsers: 3,
	lowUtterances: 4,
	hardTokens: 900,
	softTokens: 600,
	lowTokens: 400,
	summaryTokens: 150,
	/** A small window keeps at least this much before a cut. */
	floorTokens: 300,
} as const;

/** The bounds for a model window: the size-first bounds, lowered where the window's own plan leaves less. */
export function workingLimits(plan: WindowPlan): WorkingLimits {
	const hardTokens = Math.max(
		HISTORY.floorTokens,
		Math.min(HISTORY.hardTokens, plan.log.high, Math.floor(plan.room * 0.45)),
	);
	return {
		hardTokens,
		hardUsers: HISTORY.hardUsers,
		softTokens: Math.min(HISTORY.softTokens, Math.floor(hardTokens * 0.67)),
		softUsers: HISTORY.softUsers,
		lowTokens: Math.min(HISTORY.lowTokens, Math.floor(hardTokens * 0.45)),
		lowUtterances: HISTORY.lowUtterances,
		summaryMaxTokens: Math.min(HISTORY.summaryTokens, plan.sections.episode),
	};
}

/** Estimated tokens of one utterance as the recent conversation draws it: its bounded words and the mark of its calls. */
export function utteranceTokens(u: Utterance): number {
	const mark = callsMark(replayableCalls(u));
	return (
		estimateTextTokens(headWithin(u.text, RECENT.utteranceTokens).text) +
		(mark ? estimateTextTokens(mark) : 0)
	);
}

export const tokensOf = (utterances: readonly Utterance[]) =>
	utterances.reduce((sum, u) => sum + utteranceTokens(u), 0);

export const userCountOf = (utterances: readonly Utterance[]) =>
	utterances.reduce((sum, u) => sum + (u.speaker === "user" ? 1 : 0), 0);

export function overHardLimit(
	utterances: readonly Utterance[],
	limits?: WorkingLimits,
): boolean {
	return limits
		? userCountOf(utterances) > limits.hardUsers ||
				tokensOf(utterances) > limits.hardTokens
		: utterances.length > RECENT.hardCount ||
				tokensOf(utterances) > RECENT.hardTokens;
}

/** The seq a fixed-rule cut is placed after: keeps up to `lowUtterances` within `lowTokens`, starting with an agent's. */
export function keepNewestCut(
	shown: readonly Utterance[],
	fallback: number,
	limits?: Pick<WorkingLimits, "lowUtterances" | "lowTokens">,
): number {
	const maxCount = limits?.lowUtterances ?? RECENT.keep;
	let at = Math.max(0, shown.length - maxCount);
	if (limits) {
		let used = 0;
		let chosen = shown.length;
		for (let i = shown.length - 1; i >= at; i--) {
			const cost = utteranceTokens(shown[i]!);
			if (chosen < shown.length && used + cost > limits.lowTokens) break;
			used += cost;
			chosen = i;
		}
		at = chosen;
	}
	while (at < shown.length && shown[at]!.speaker === "user") at++;
	if (at >= shown.length) return shown.at(-1)?.seq ?? fallback;
	return shown[at]!.seq - 1;
}

export const shortSummaryTime = (iso: string) =>
	jstDisplay(Date.parse(iso)).slice(5, 16);

function summarizeToolCallLine(call: Utterance["toolCalls"][number]): string {
	const args = lineText(call.arguments).slice(0, 100);
	const res = lineText(call.result).slice(0, 120);
	return `${call.name}(${args}) -> ${res}`;
}

/**
 * Deterministic 0ms fallback summary used when Hard threshold is reached before a background LLM summary is ready
 * (or when the staged summary was invalidated or still leaves the working area over Hard limit).
 */
export function buildMechanicalSummary(
	existing: ConversationSummary | null,
	dropped: readonly Utterance[],
	maxTokens = MECHANICAL_MAX_TOKENS,
): string {
	if (!dropped.length) return existing?.text ?? "";
	const first = dropped[0]!;
	const last = dropped.at(-1)!;
	const lines: string[] = [
		`対象範囲: ${shortSummaryTime(first.at)}〜${shortSummaryTime(last.at)}（圧縮済み履歴の簡易記録。詳細は read_history で確認可）`,
	];
	if (existing?.text) {
		const prevLines = existing.text
			.split("\n")
			.filter((l) => l.trim() && !l.startsWith("対象範囲:"));
		for (const line of prevLines.slice(0, 4))
			lines.push(headWithin(line, 80).text);
	}
	const toolLines: string[] = [];
	const topicLines: string[] = [];
	for (const u of dropped) {
		if (u.speaker === "user" && u.text.trim()) {
			topicLines.push(
				`- 利用者(${shortSummaryTime(u.at)}): ${headWithin(lineText(u.text), 60).text}`,
			);
		}
		for (const call of replayableCalls(u)) {
			toolLines.push(
				`- 道具(${shortSummaryTime(u.at)}): ${summarizeToolCallLine(call)}`,
			);
		}
	}
	for (const line of toolLines.slice(-6)) lines.push(line);
	for (const line of topicLines.slice(-4)) lines.push(line);
	return headWithin(lines.join("\n"), maxTokens).text;
}

/** Collect text and provenance together. A reply whose manifest was purged or excluded cannot be summarized. */
export function summaryMaterial(
	deps: DialogueDeps,
	tx: Database,
	conversationId: string,
	existing: ConversationSummary | null,
	candidates: readonly Utterance[],
) {
	const refs = new Set(existing?.sourceRefs);
	const withheld = excludedOnlyIn(
		deps,
		tx,
		candidates.flatMap((u) => (u.messageId ? [u.messageId] : [])),
	);
	const dropped: Utterance[] = [];
	for (const u of candidates) {
		if (!u.messageId || withheld.has(u.messageId)) continue;
		const sources = inheritedHistorySources(
			deps,
			tx,
			conversationId,
			u,
			!!deps.memory || !!deps.agency?.inputForMessageInTransaction,
		);
		if (!sources) continue;
		dropped.push(u);
		refs.add(u.messageId);
		for (const ref of sources) refs.add(ref);
	}
	return { dropped, sourceRefs: [...refs] };
}

export function summaryRefsValid(
	deps: DialogueDeps,
	tx: Database,
	conversationId: string,
	refs: readonly string[],
): boolean {
	if (
		deps.agency?.isCurrentInputInTransaction?.(
			tx,
			{ sources: refs, complete: true },
			conversationId,
		) === false
	)
		return false;
	if (!deps.memory) return true;
	if (deps.memory.referenceInputs.staleInTransaction(tx, refs).length > 0)
		return false;
	const msgRefs = refs.filter((ref) => !ref.includes(":"));
	if (excludedOnlyIn(deps, tx, msgRefs).size > 0) return false;
	const blocked = new Set(
		deps.memory.blockedMessageIdsOfConversationInTransaction(
			tx,
			conversationId,
		),
	);
	return !refs.some((ref) => blocked.has(ref));
}

/**
 * Resolves the cut seq on an `over_limit` compaction: promotes a valid pre-computed `staged` LLM summary in 0ms
 * when its cut leaves the working area within Hard limits, else installs an instant mechanical fallback summary.
 */
export function compactOnOverLimitInTransaction(
	deps: DialogueDeps,
	tx: Database,
	conversationId: string,
	existing: ConversationCut,
	shown: readonly Utterance[],
	at: string,
	limits?: WorkingLimits,
): number {
	const store = deps.conversation.input;
	const staged = store.stagedSummaryInTransaction?.(
		tx,
		conversationId,
		existing.revision,
	);
	if (
		staged &&
		staged.coveredThroughSeq > existing.seq &&
		summaryRefsValid(deps, tx, conversationId, staged.sourceRefs)
	) {
		const remaining = shown.filter((u) => u.seq > staged.coveredThroughSeq);
		if (!overHardLimit(remaining, limits)) {
			store.activateStagedSummaryInTransaction?.(
				tx,
				conversationId,
				staged.id,
				at,
			);
			return staged.coveredThroughSeq;
		}
	}
	const targetSeq = keepNewestCut(shown, existing.seq, limits);
	const candidates = shown.filter((u) => u.seq <= targetSeq);
	if (candidates.length && store.replaceActiveSummaryInTransaction) {
		const current =
			store.activeSummaryInTransaction?.(tx, conversationId) ?? null;
		const validCurrent =
			current && summaryRefsValid(deps, tx, conversationId, current.sourceRefs)
				? current
				: null;
		const { dropped, sourceRefs } = summaryMaterial(
			deps,
			tx,
			conversationId,
			validCurrent,
			candidates,
		);
		if (!dropped.length) {
			if (!validCurrent)
				store.clearSummariesInTransaction?.(tx, conversationId);
			else store.clearStagedSummariesInTransaction?.(tx, conversationId);
			return targetSeq;
		}
		const text = buildMechanicalSummary(validCurrent, dropped);
		if (text && summaryRefsValid(deps, tx, conversationId, sourceRefs)) {
			store.replaceActiveSummaryInTransaction(tx, {
				id: deps.id(),
				conversationId,
				baseCutRevision: existing.revision,
				coveredFromSeq: validCurrent?.coveredFromSeq ?? dropped[0]!.seq,
				coveredThroughSeq: targetSeq,
				text,
				sourceRefs,
				tokenEstimate: estimateTextTokens(text),
				kind: "mechanical",
				at,
			});
		}
	}
	return targetSeq;
}
