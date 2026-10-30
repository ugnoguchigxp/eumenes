/**
 * What the two kinds of measured turn share (`harness-turn.ts`, the agent's reply loop; `harness-routed.ts`, the
 * local harness's routed turn): the shape of a turn's result, the environment it runs on, the numbers the simulated
 * host names works by, and the recorder that times each model call and files its detail, also when the call fails.
 */
import type { UtteranceToolCall } from "../../api/domains/conversation";
import type { DocumentRefs } from "../../api/domains/dialogue/service/work-items";
import { errorCodeOf, newDetail, type CallDetail } from "./harness-detail";
import type {
	CallKind,
	CallSettings,
	ModelClient,
	TaggedCall,
} from "./harness-client";
import type { Turn } from "./harness-judge";

/** A model call's time limit. */
export const CALL_TIMEOUT_MS = 180_000;
export const callSignal = () => AbortSignal.timeout(CALL_TIMEOUT_MS);

/** The numbers the host names works by: the simulated works are `w<n>`, shown as `t<n>`. */
export const refs: DocumentRefs = {
	todo: (id) => (id.startsWith("w") ? `t${id.slice(1)}` : null),
	confirmation: () => null,
	resource: () => null,
};

export type TurnResult = Turn & {
	/** What a later turn sees of this one: the carried searches, hand-overs and questions back. */
	toolCalls: UtteranceToolCall[];
	ms: number;
	/** Every timed model call of the turn, by which call it was. */
	calls: TaggedCall[];
	/** The host spoke words after its last model call (a hand-over's announcement, a question back, a fixed phrase). */
	hostSpoke: boolean;
	/** What each model call did, in order. */
	details: CallDetail[];
	/**
	 * Why the turn ended: an answer in words, a hand-over, a question back, a choice that could not be carried out,
	 * an error, or (the reply loop) the rounds ran out.
	 */
	stop: "answer" | "handover" | "ask" | "check" | "error" | "rounds";
};

/** What a turn runs on. */
export type TurnEnv = {
	client: ModelClient;
	settings: CallSettings;
	/** The system-copy check of the harness's gate (absent when the gate is off). */
	copies?: (text: string) => boolean;
};

/** Runs model calls and files each one's timing and detail under its kind. */
export function createRecorder() {
	const calls: TaggedCall[] = [];
	const details: CallDetail[] = [];
	/**
	 * Runs one model call and files its timing and detail under `kind`, also when the call fails: an error keeps its
	 * code and how much had arrived.
	 */
	const timed = async <T>(
		kind: CallKind,
		client: ModelClient,
		run: (detail: CallDetail) => Promise<T>,
	): Promise<T> => {
		const detail = newDetail(kind);
		details.push(detail);
		let failure: unknown = null;
		try {
			return await run(detail);
		} catch (error) {
			failure = error;
			throw error;
		} finally {
			for (const metrics of await client.take()) {
				calls.push({ kind, metrics });
				detail.reasoningChars += metrics.reasoningChars;
				detail.finishReason ??= metrics.finishReason;
			}
			if (failure)
				detail.error = {
					code: errorCodeOf(failure),
					textChars: detail.textChars,
					reasoningChars: detail.reasoningChars,
				};
		}
	};
	return { calls, details, timed };
}
