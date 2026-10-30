import {
	LlmCallError,
	LlmOutputError,
	type LlmPort,
	type LlmRequest,
	type LlmResult,
} from "eumenes-agency";
import { z } from "zod";
import type { NativeTool } from "../../infrastructure/chat-stream";
import type { InferencePort, Messages } from "../../domains/inference";
import { toErrorCode } from "../../infrastructure/error-code";
import { LlmJsonError, parseLlmJson } from "../../infrastructure/llm-json";
import type { SqliteStore } from "../../infrastructure/sqlite";

/** The background control limits of the inference domain (`background-control.ts`). */
export const BACKGROUND_OUTPUT_LIMIT = 1500;
/**
 * A structured call on the conversation route takes the structured cap (300 s): LARM thinks at length before the
 * answer, and the call yields to the user's calls meanwhile. The cloud fallback reserves its own time out of it.
 */
export const BACKGROUND_DEADLINE_MS = 300_000;
/** A decision id is `<conversation>.<opportunity|bg>.<n>`; inference accepts `[a-zA-Z0-9_.:-]{1,160}`. */
const DECISION_ID = /^[a-zA-Z0-9_.:-]{1,160}$/;

export type AgencyAttemptUsage = {
	model: string | null;
	inputTokens: number | null;
	outputTokens: number | null;
	cacheReadTokens: number | null;
};

/** The host names each call: the id must be unique per call (inference binds it to the request). */
export type AgencyCallIdentity = {
	decisionId: string;
	/** The host's execution generation (positive); bumped when input invalidates background work. */
	generation: number;
	/** The conversation the call is about: its prompt prefix is shared when `task` gives one. */
	conversationId?: string;
};

export type AgencyLlmPortDeps = {
	store: Pick<SqliteStore, "write">;
	inference: Required<
		Pick<
			InferencePort,
			| "captureBackgroundControlInTransaction"
			| "executeControl"
			| "acceptInTransaction"
		>
	> &
		Pick<InferencePort, "rejectControlInTransaction">;
	next(request: LlmRequest<unknown>): AgencyCallIdentity;
	/**
	 * The conversation's prompt with this call's `## Task` last (the prefix its generations share, then `## State`;
	 * the conversation input specification, section 10). With one, the call runs on the conversation's connection;
	 * absent or null, the call is its own system and prompt.
	 */
	task?(
		conversationId: string,
		task: string,
	): {
		messages: Messages;
		tools: NativeTool[];
	} | null;
	/** Token counts and model of the served attempt (the receipt carries none). Absent: zeros. */
	attemptUsage?(attemptId: string): AgencyAttemptUsage | null;
	nowMs?(): number;
};

const TRANSIENT =
	/^(deadline_exceeded|local_timeout|network_unavailable|larm_connection_failed|larm_(control|inference)_(429|502|503|504))$/;

/** Maps an inference failure to the core's call error; an abort of the caller's signal propagates as is. */
function callError(error: unknown, signal: AbortSignal): never {
	if (signal.aborted) throw error;
	const code = toErrorCode(error, "inference_failed");
	// The call yielded its LARM slot to the foreground: an abort from below, so the core neither tries it again at
	// once (the foreground has just begun) nor counts it against the batch.
	if (code === "larm_preempted") {
		const yielded = new Error(code);
		yielded.name = "AbortError";
		throw yielded;
	}
	if (TRANSIENT.test(code)) throw new LlmCallError("connection", true);
	if (error instanceof DOMException && error.name === "TimeoutError")
		throw new LlmCallError("connection", true);
	throw new LlmCallError(code, false);
}

/** The agency core's LlmPort on Eumenes inference background control, on the conversation's LLM route. */
export function createAgencyLlmPort(deps: AgencyLlmPortDeps): LlmPort {
	const nowMs = deps.nowMs ?? Date.now;
	const { inference } = deps;
	return {
		async complete<T>(
			request: LlmRequest<T>,
			signal: AbortSignal,
		): Promise<LlmResult<T>> {
			signal.throwIfAborted();
			const identity = deps.next(request);
			const maxOutputTokens = Math.min(
				BACKGROUND_OUTPUT_LIMIT,
				Math.max(1, Math.floor(request.maxOutputTokens)),
			);
			const outputSchema = z.toJSONSchema(request.schema);
			if (!DECISION_ID.test(identity.decisionId))
				throw new LlmCallError("invalid_background_control", false);

			const deadline = nowMs() + BACKGROUND_DEADLINE_MS;
			let requestId: string;
			try {
				requestId = await deps.store.write((db) =>
					inference.captureBackgroundControlInTransaction(db, {
						taskId: "agency",
						decisionId: identity.decisionId,
						authorityEpoch: 1,
						executionGeneration: identity.generation,
						deadline,
						taskDeadline: deadline,
						maxOutputTokens,
						structuredOutput: true,
						route: "conversation",
					}),
				);
			} catch (error) {
				throw new LlmCallError(toErrorCode(error, "capture_failed"), false);
			}

			const conversationId = identity.conversationId;
			const prefix =
				conversationId && deps.task
					? deps.task(conversationId, `${request.system}\n\n${request.prompt}`)
					: null;
			const started = nowMs();
			let receipt: Awaited<ReturnType<typeof inference.executeControl>>;
			try {
				receipt = await inference.executeControl(
					requestId,
					prefix
						? prefix.messages
						: [
								{ role: "system", content: request.system },
								{ role: "user", content: request.prompt },
							],
					AbortSignal.any([
						signal,
						AbortSignal.timeout(BACKGROUND_DEADLINE_MS),
					]),
					{ instructions: request.system, outputSchema },
					// Either way the agency yields: a call made for the user aborts it (`larm_preempted`).
					prefix
						? {
								sessionRole: "auxiliary",
								onConversation: true,
								prefixTools: prefix.tools,
								toolChoice: "none",
							}
						: { sessionRole: "auxiliary", yields: true },
				);
			} catch (error) {
				return callError(error, signal);
			}
			const latencyMs = Math.max(0, nowMs() - started);
			// A result that arrives after cancellation is never adopted.
			signal.throwIfAborted();

			const used = deps.attemptUsage?.(receipt.attemptId) ?? null;
			const usage = {
				model: used?.model ?? "conversation",
				inputTokens: used?.inputTokens ?? 0,
				outputTokens: used?.outputTokens ?? 0,
				cacheReadTokens: used?.cacheReadTokens ?? 0,
			};
			const rejectOutput = async (reasonCode: string): Promise<never> => {
				await deps.store
					.write((db) =>
						inference.rejectControlInTransaction?.(db, receipt, reasonCode),
					)
					.catch(() => undefined);
				throw new LlmOutputError(reasonCode, usage.model, {
					inputTokens: usage.inputTokens,
					outputTokens: usage.outputTokens,
				});
			};

			let parsed: z.ZodSafeParseResult<T>;
			try {
				parsed = request.schema.safeParse(parseLlmJson(receipt.value));
			} catch (error) {
				return rejectOutput(
					error instanceof LlmJsonError ? "malformed_json" : "malformed_output",
				);
			}
			if (!parsed.success) return rejectOutput("schema_mismatch");

			const accepted = await deps.store
				.write((db) => inference.acceptInTransaction(db, receipt))
				.catch(() => false);
			if (!accepted) throw new LlmCallError("receipt_rejected", false);
			signal.throwIfAborted();
			return { value: parsed.data, ...usage, latencyMs };
		},
	};
}
