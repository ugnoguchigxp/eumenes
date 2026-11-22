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
import { replayableCalls } from "./tool-exchange";

const MECHANICAL_MAX_TOKENS = 400;
const WIDE_WINDOW_TOKENS = 65_536;

/** Default legacy cut bounds when no window-derived `WorkingLimits` are passed. */
export const RECENT = {
	/** One utterance shows at most this much; the rest is cut with `…`. */
	utteranceTokens: 300,
	hardCount: 20,
	hardTokens: 4000,
	/** A fixed-rule cut keeps this many newest utterances (starting with the agent's). */
	keep: 4,
	/** A silence this long before an input starts the recent conversation again. */
	gapMs: 30 * 60 * 1000,
} as const;

/** Cache-first epoch thresholds derived from the active model window (`planWindow()`). */
export type WorkingLimits = {
	hardTokens: number;
	hardUsers: number;
	softTokens: number;
	softUsers: number;
	lowTokens: number;
	lowUtterances: number;
	summaryMaxTokens: number;
};

/** Derives Soft/Hard/Low epoch limits from `planWindow()` so wide (256k) and narrow (local) windows both fit safely. */
export function workingLimits(plan: WindowPlan): WorkingLimits {
	if (plan.window >= WIDE_WINDOW_TOKENS) {
		const hardTokens = Math.max(
			4_000,
			Math.min(24_000, Math.floor(plan.room * 0.35)),
		);
		return {
			hardTokens,
			hardUsers: 20,
			softTokens: Math.floor(hardTokens * 0.75),
			softUsers: 15,
			lowTokens: Math.min(6_000, Math.floor(hardTokens * 0.35)),
			lowUtterances: 8,
			summaryMaxTokens: Math.min(1_500, plan.sections.episode),
		};
	}
	const hardTokens = Math.max(
		1_500,
		Math.min(plan.log.high, Math.floor(plan.room * 0.45)),
	);
	return {
		hardTokens,
		hardUsers: 10,
		softTokens: Math.floor(hardTokens * 0.75),
		softUsers: 8,
		lowTokens: Math.min(2_000, Math.floor(hardTokens * 0.35)),
		lowUtterances: 4,
		summaryMaxTokens: Math.min(600, plan.sections.episode),
	};
}

/** Estimated tokens of one utterance, including its replayable tool calls and results. */
export function utteranceTokens(u: Utterance): number {
	let sum = estimateTextTokens(u.text);
	for (const call of replayableCalls(u))
		sum +=
			estimateTextTokens(call.name) +
			estimateTextTokens(call.arguments) +
			estimateTextTokens(call.result) +
			12;
	return sum;
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
		`対象範囲: ${shortSummaryTime(first.at)}〜${shortSummaryTime(last.at)}（圧縮済み履歴の簡易記録。詳細は read_history / read_agents で確認可）`,
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

/** Collects all source references (message IDs + inherited run provenance + previous summary refs) for forgetting. */
export function collectSummarySourceRefs(
	deps: DialogueDeps,
	tx: Database,
	existing: ConversationSummary | null,
	dropped: readonly Utterance[],
): string[] {
	const refs = new Set<string>(existing?.sourceRefs ?? []);
	for (const u of dropped) {
		if (!u.messageId) continue;
		refs.add(u.messageId);
		const source = deps.conversation.sourceInTransaction(tx, u.messageId);
		if (source.state === "available" && source.message.runId) {
			const runInput = deps.memory?.referenceInputs.readRunInTransaction(
				tx,
				source.message.runId,
			);
			for (const ref of runInput?.sources ?? []) refs.add(ref);
		}
	}
	return [...refs];
}

export function summaryRefsValid(
	deps: DialogueDeps,
	tx: Database,
	conversationId: string,
	refs: readonly string[],
): boolean {
	if (!refs.length || !deps.memory) return true;
	if (deps.memory.referenceInputs.staleInTransaction(tx, refs).length > 0)
		return false;
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
	const dropped = shown.filter((u) => u.seq <= targetSeq);
	if (dropped.length && store.replaceActiveSummaryInTransaction) {
		const current =
			store.activeSummaryInTransaction?.(tx, conversationId) ?? null;
		const validCurrent =
			current && summaryRefsValid(deps, tx, conversationId, current.sourceRefs)
				? current
				: null;
		const text = buildMechanicalSummary(validCurrent, dropped);
		const sourceRefs = collectSummarySourceRefs(
			deps,
			tx,
			validCurrent,
			dropped,
		);
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
