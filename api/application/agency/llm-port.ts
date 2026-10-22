import {
	LlmCallError,
	LlmOutputError,
	type LlmPort,
	type LlmRequest,
	type LlmResult,
} from "eumenes-agency";
import { z } from "zod";
import type { InferencePort } from "../../domains/inference";
import type { Settings } from "../../domains/settings";
import { toErrorCode } from "../../infrastructure/error-code";
import { LlmJsonError, parseLlmJson } from "../../infrastructure/llm-json";
import type { SqliteStore } from "../../infrastructure/sqlite";

/** The background control limits of the inference domain (`background-control.ts`). */
export const BACKGROUND_OUTPUT_LIMIT = 1500;
export const BACKGROUND_DEADLINE_MS = 30_000;
/** A decision id is `<conversation>.<opportunity|bg>.<n>`; inference accepts `[a-zA-Z0-9_.:-]{1,160}`. */
const DECISION_ID = /^[a-zA-Z0-9_.:-]{1,160}$/;

export type AgencyRouteRefusal =
	| "resource_missing"
	| "connection_disabled"
	| "cloud_not_allowed";

/**
 * The saved cloud resource `agency.resourceId` names cannot be used. Inference would downgrade such a
 * request to the conversation route or LARM; agency never falls back silently, so the call is refused
 * and the host stops agency and logs the reason. Not retryable.
 */
export class AgencyRouteRefusedError extends LlmCallError {
	constructor(readonly refusal: AgencyRouteRefusal) {
		super("agency_resource_unusable", false);
		this.name = "AgencyRouteRefusedError";
	}
}

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
};

export type AgencyLlmPortDeps = {
	store: Pick<SqliteStore, "write">;
	inference: Required<
		Pick<
			InferencePort,
			| "snapshotInTransaction"
			| "captureBackgroundControlInTransaction"
			| "executeControl"
			| "acceptInTransaction"
		>
	> &
		Pick<InferencePort, "rejectControlInTransaction">;
	next(request: LlmRequest<unknown>): AgencyCallIdentity;
	/** Token counts and model of the served attempt (the receipt carries none). Absent: zeros. */
	attemptUsage?(attemptId: string): AgencyAttemptUsage | null;
	nowMs?(): number;
};

/** Mirrors `routeToResource`'s usable condition without changing the request. */
function refusalFor(
	snapshot: Settings,
	resourceId: string,
): AgencyRouteRefusal | null {
	const resource = snapshot.resources.find(
		(r) => r.id === resourceId && r.purpose === "llm",
	);
	if (!resource) return "resource_missing";
	const connection = snapshot.connections.find(
		(c) => c.id === resource.connectionId,
	);
	if (!connection?.enabled) return "connection_disabled";
	if (!snapshot.routes.llm.cloudAllowed) return "cloud_not_allowed";
	return null;
}

const TRANSIENT =
	/^(deadline_exceeded|local_timeout|network_unavailable|larm_connection_failed|larm_(control|inference)_(429|502|503|504))$/;

/** Maps an inference failure to the core's call error; an abort of the caller's signal propagates as is. */
function callError(error: unknown, signal: AbortSignal): never {
	if (signal.aborted) throw error;
	const code = toErrorCode(error, "inference_failed");
	if (TRANSIENT.test(code)) throw new LlmCallError("connection", true);
	if (error instanceof DOMException && error.name === "TimeoutError")
		throw new LlmCallError("connection", true);
	throw new LlmCallError(code, false);
}

/**
 * The agency core's LlmPort on Eumenes inference background control: `agency.resourceId` set uses that
 * saved cloud resource (and refuses instead of downgrading), null uses the LARM local LLM.
 */
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
			let modelHint: string;
			try {
				({ requestId, modelHint } = await deps.store.write((db) => {
					const snapshot = inference.snapshotInTransaction(db);
					const resourceId = snapshot.agency.resourceId;
					if (resourceId) {
						const refusal = refusalFor(snapshot, resourceId);
						if (refusal) throw new AgencyRouteRefusedError(refusal);
					}
					const id = inference.captureBackgroundControlInTransaction(db, {
						taskId: "agency",
						decisionId: identity.decisionId,
						authorityEpoch: 1,
						executionGeneration: identity.generation,
						deadline,
						taskDeadline: deadline,
						maxOutputTokens,
						structuredOutput: true,
						route: resourceId ? { resourceId } : undefined,
					});
					const resource = resourceId
						? snapshot.resources.find((r) => r.id === resourceId)
						: undefined;
					return { requestId: id, modelHint: resource?.model ?? "larm" };
				}));
			} catch (error) {
				if (error instanceof LlmCallError) throw error;
				throw new LlmCallError(toErrorCode(error, "capture_failed"), false);
			}

			const started = nowMs();
			let receipt: Awaited<ReturnType<typeof inference.executeControl>>;
			try {
				receipt = await inference.executeControl(
					requestId,
					[{ role: "user", content: request.prompt }],
					AbortSignal.any([
						signal,
						AbortSignal.timeout(BACKGROUND_DEADLINE_MS),
					]),
					{ instructions: request.system, outputSchema },
				);
			} catch (error) {
				return callError(error, signal);
			}
			const latencyMs = Math.max(0, nowMs() - started);
			// A result that arrives after cancellation is never adopted.
			signal.throwIfAborted();

			const used = deps.attemptUsage?.(receipt.attemptId) ?? null;
			const usage = {
				model: used?.model ?? modelHint,
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
