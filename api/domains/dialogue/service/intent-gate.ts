import { getLogger } from "../../../infrastructure/logger";
import type { IntentJudgment } from "../../inference";
import {
	insertIntentJudgment,
	observeIntentJudgment,
	type IntentJudgmentRow,
} from "../repository/intent";
import type { DialogueDeps, GenerateInput } from "./context";

const log = getLogger("dialogue");

/**
 * How a turn is routed (the local harness rebuild plan, section 4.1): `search`, the judge found a request of work
 * (the request turn); `answer`, it found none (the talk turn); `free`, there is no judgement to route by (a failure,
 * or `shadow`): the request turn decides, and its choice may be none. The judge is read as two choices: a `request`
 * scored at the saved threshold or above, or anything else.
 */
export type IntentRoute = "free" | "search" | "answer";

/** The routing a judgement asks for under the saved threshold (a threshold on a score, not a chance of being right). */
export function routeOf(
	judgment: IntentJudgment,
	searchScore: number,
): IntentRoute {
	return judgment.choice === "request" &&
		judgment.probabilities.request >= searchScore
		? "search"
		: "answer";
}

export type IntentGate = {
	route: IntentRoute;
	/** What the model then did in the generation, kept with the judgement (the shadow comparison). */
	observe(observed: { searched: boolean; delegated: boolean }): void;
};

const NO_GATE: IntentGate = { route: "free", observe() {} };
/** How long `shadow` lets a judgement run for its record; the generation never waits for it. */
const SHADOW_MS = 10_000;
/** The agent's utterance the judge reads is cut to its end; the user's newest one to its start. */
const PREVIOUS_CHARS = 1000;
const TEXT_CHARS = 2000;

/** The agent's words before the newest utterance: the last of the recent conversation (none after a gap cut it). */
function previousAgent(input: GenerateInput): string | null {
	for (let i = input.messages.length - 1; i >= 0; i--) {
		const m = input.messages[i]!;
		if (m.role === "assistant" && !m.tool_calls && m.content.trim())
			return m.content.trim().slice(-PREVIOUS_CHARS);
	}
	return null;
}

function reasonOf(
	error: unknown,
	signal: AbortSignal,
	timeout?: AbortSignal,
): string {
	if (signal.aborted) return "cancelled";
	if (
		timeout?.aborted ||
		(error instanceof DOMException && error.name === "TimeoutError")
	)
		return "timeout";
	return error instanceof Error && /^[a-z0-9_]{1,80}$/.test(error.message)
		? error.message
		: "intent_judge_failed";
}

/**
 * Judges the newest utterance of a generation before its first model call, when the local harness serves it and the
 * saved mode asks for the judge. `shadow` starts the judgement and returns at once (the routing stays today's);
 * `ruri` waits for it up to the saved bound. A failure keeps today's routing. The judgement belongs to this
 * generation and its message only: a cancelled run aborts it, and a result that comes late changes nothing.
 */
export async function openIntentGate(
	deps: DialogueDeps,
	input: GenerateInput,
	signal: AbortSignal,
): Promise<IntentGate> {
	// A generation without a final message (a decision-only fixture) has nothing to judge.
	if (input.harness.name !== "local" || input.final?.kind !== "utterances")
		return NO_GATE;
	const messageId = input.final.messageIds.at(-1);
	const text = input.utterances?.at(-1)?.trim().slice(0, TEXT_CHARS);
	const snapshot = deps.larm.snapshotInTransaction?.bind(deps.larm);
	if (!messageId || !text || !snapshot) return NO_GATE;
	const settings = deps.store.read((tx) => snapshot(tx)).intent;
	// Until a profile is saved there is no judge: nothing is asked or recorded.
	if (!settings || settings.mode === "legacy" || !settings.profile)
		return NO_GATE;
	const mode = settings.mode;
	const id = crypto.randomUUID();
	const started = performance.now();
	const judge = deps.larm.judgeIntent?.bind(deps.larm);
	const timeout = AbortSignal.timeout(
		mode === "ruri" ? settings.timeoutMs : SHADOW_MS,
	);
	const outcome = (async () => {
		if (!judge) throw new Error("intent_judge_unavailable");
		return judge(
			{ text, previousAgent: previousAgent(input) },
			AbortSignal.any([signal, timeout]),
		);
	})().then(
		(judgment) => ({ judgment, reason: null as string | null }),
		(error: unknown) => ({
			judgment: null,
			reason: reasonOf(error, signal, timeout),
		}),
	);
	let observed: { searched: boolean; delegated: boolean } | undefined;
	let written: Promise<void> | undefined;
	const record = (
		result: Awaited<typeof outcome>,
		route: IntentRoute,
	): Promise<void> => {
		const row: IntentJudgmentRow = {
			id,
			conversationId: input.conversationId,
			runId: input.runId,
			messageId,
			mode,
			judgment: result.judgment,
			legacyRoute: "free",
			finalRoute: route,
			durationMs: performance.now() - started,
			fallbackReason: result.reason,
			...(observed ? { observed } : {}),
			createdAt: new Date().toISOString(),
		};
		// The scores, the model and its revision are the record's; the log names the label and the routing.
		log.info("dialogue.intent_judged", {
			runId: input.runId,
			utteranceId: messageId,
			kind: mode,
			...(result.judgment ? { decision: result.judgment.choice } : {}),
			route,
			durationMs: Math.round(row.durationMs),
			...(result.reason ? { reason: result.reason } : {}),
		});
		// A record that cannot be written never stops the conversation.
		return deps.store
			.write((tx) => insertIntentJudgment(tx, row))
			.catch((error: unknown) => {
				log.warn("dialogue.intent_record_failed", {
					reason: reasonOf(error, new AbortController().signal),
				});
			});
	};
	const observe = (next: { searched: boolean; delegated: boolean }) => {
		observed = next;
		void written?.then(() =>
			deps.store
				.write((tx) => observeIntentJudgment(tx, id, next))
				.catch(() => {}),
		);
	};
	if (mode === "shadow") {
		void outcome.then((result) => {
			written = record(result, "free");
		});
		return { route: "free", observe };
	}
	const result = await outcome;
	// A cancelled run is recorded as judged (or not) and goes no further: its result reaches no other run.
	const route =
		result.judgment && !signal.aborted
			? routeOf(result.judgment, settings.searchScore)
			: "free";
	written = record(result, route);
	signal.throwIfAborted();
	return { route, observe };
}
