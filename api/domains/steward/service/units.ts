import { parseLlmJson } from "../../../infrastructure/llm-json";
import { isNetworkError } from "../../../infrastructure/error-code";
import {
	INFERENCE_MS,
	MAX_OUTPUT_BYTES,
	STEWARD_KIND,
	STEWARD_RESOURCE,
	type StewardJobHandler,
	type StewardPayload,
	payloadSchema,
} from "../contracts";
import { readUnit, closeUnit, takeRequests } from "../repository";
import type { Kick } from "./kick";
import { buildMessages, taskText } from "./messages";
import { createUnitEnd } from "./unit-end";
import { createPrepare } from "./unit-prepare";
import { createSettle } from "./unit-settle";
import type { StewardDeps, StewardInput, StewardOutput } from "./types";
import type { Wake } from "./wake";

/**
 * The steps that read the conversation: they run on its prompt (its prefix, then their task) and its connection.
 * Upkeep and the World curation read other things and keep their own prompts.
 */
const ON_CONVERSATION: ReadonlySet<string> = new Set([
	"curate-memory",
	"curate-goals",
]);

/** A failure of the transport or a busy backend: the same job is tried again by the queue. */
const TRANSIENT =
	/^(local_timeout|network_unavailable|larm_(control|inference)_(429|502|503|504)|larm_connection_(failed|expired)|larm_connect_timeout|larm_renew_busy)$/;
function transient(error: unknown): boolean {
	if (isNetworkError(error)) return true;
	if (error instanceof DOMException && error.name === "TimeoutError")
		return true;
	return error instanceof Error && TRANSIENT.test(error.message);
}

/** The queue handler of `steward.step.v1`: prepare fences the unit, execute asks the model, settle adopts or drops. */
export function createUnitHandler(deps: StewardDeps, kick: Kick, wake: Wake) {
	const { inference } = deps;
	const end = createUnitEnd(deps, kick, wake);
	const prepareInTransaction = createPrepare(deps, kick, end, wake);
	const settleInTransaction = createSettle(deps, kick, end);

	async function execute(
		input: StewardInput,
		context: { signal: AbortSignal },
	): Promise<StewardOutput> {
		const started = deps.nowMs();
		const { step, prepared } = input;
		const before = await step.beforeInfer?.(prepared, {
			signal: context.signal,
			deps,
		});
		const data = before?.data ?? prepared.data;
		// The conversation's prompt as it stands now (read at the call, so its prefix is what the next generation sends).
		const read = ON_CONVERSATION.has(step.id)
			? deps.conversationTask?.()
			: undefined;
		const prefix = read
			? deps.store.read((db) =>
					read(db, input.conversationId, taskText(step, prepared, data)),
				)
			: null;
		const messages = prefix
			? prefix.messages
			: before?.data === undefined
				? input.messages
				: buildMessages(step, prepared, before.data);
		const receipt = await inference.executeControl(
			input.requestId,
			messages,
			AbortSignal.any([context.signal, AbortSignal.timeout(INFERENCE_MS)]),
			{
				instructions: step.instructions,
				outputSchema: step.outputSchema(prepared),
			},
			// Either way the step yields: a call made for the user aborts it and the unit is tried again later.
			prefix
				? {
						sessionRole: "auxiliary",
						onConversation: true,
						prefixTools: prefix.tools,
						toolChoice: "none",
					}
				: { sessionRole: "auxiliary", yields: true },
		);
		// A malformed answer is data, not a failure: settle counts it and moves on.
		let output: unknown | null = null;
		let content = "";
		try {
			content =
				typeof receipt.value === "string"
					? receipt.value
					: new TextDecoder().decode(receipt.value);
			output = step.parse(parseLlmJson(receipt.value, MAX_OUTPUT_BYTES));
		} catch {
			output = null;
		}
		const extras =
			output === null
				? before?.extras
				: ((await step.afterInfer?.(prepared, output, before?.extras, {
						signal: context.signal,
						deps,
					})) ?? before?.extras);
		return {
			receipt,
			output,
			extras,
			outputTokens:
				inference.countControlTokens?.([{ role: "assistant", content }]) ??
				null,
			durationMs: deps.nowMs() - started,
		};
	}

	const handler: StewardJobHandler<
		StewardPayload,
		StewardInput,
		StewardOutput
	> = {
		kind: STEWARD_KIND,
		payloadVersions: [1],
		schema: payloadSchema,
		recovery: "interrupt",
		resourceKey: STEWARD_RESOURCE,
		prepareInTransaction,
		execute,
		classify: (error) => (transient(error) ? "retry" : "fail"),
		settleInTransaction,
		cancelInTransaction(db, job) {
			end.release(db, takeRequests(db, job.jobId));
			const unit = readUnit(db, job.payload.unitId);
			if (unit?.state !== "open") return;
			end.releaseWorld(db, unit);
			closeUnit(db, unit.id, "stale", deps.clock());
		},
	};
	return { handler };
}
