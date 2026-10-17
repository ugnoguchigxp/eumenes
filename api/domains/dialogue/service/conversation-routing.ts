import { systemContext } from "../../../infrastructure/system-context";
import { z } from "zod";
import { parseLlmJson } from "../../../infrastructure/llm-json";
import type { NativeTool } from "../../../infrastructure/chat-stream";
import type { ToolchainCard } from "../../capabilities";
import type { InferencePort, Receipt } from "../../inference";
import type { Run } from "../contracts";
import type { DialogueDeps, GenerateInput } from "./context";
import {
	chosen,
	recordRejected,
	type SelectionDraft,
	prepareDecision,
} from "./selection-trace";
import {
	operation,
	type ConversationOperation,
	type OpenQuestion,
	type SessionOffers,
} from "./conversation-tools";

/** An option the model may leave empty: null or "" means not given. */
const optional = <T extends z.ZodType>(schema: T) =>
	z.preprocess(
		(v) => (v === null || v === "" ? undefined : v),
		schema.optional(),
	);

const routeSchema = z
	.object({
		decision: z.enum(["toolchain", "answer"]),
		functionName: z.string(),
		request: z.string(),
		questionRef: z.string(),
		/** A session toolchain's start options (omitted for the others). */
		target: optional(z.string()),
		resolveUnsaved: optional(z.literal("discard")),
	})
	.strict();

const baseProperties = {
	decision: { enum: ["toolchain", "answer"] },
	functionName: { type: "string" },
	request: { type: "string" },
	questionRef: { type: "string" },
};
/** The output schema; the session start options are offered only when a session toolchain is. */
const outputSchemaFor = (sessions: boolean) => ({
	type: "object",
	properties: sessions
		? {
				...baseProperties,
				target: { type: "string" },
				resolveUnsaved: { enum: ["discard"] },
			}
		: baseProperties,
	required: ["decision", "functionName", "request", "questionRef"],
	additionalProperties: false,
});

/** Recheck the intent with the same context when the first call returned only prose. */
export async function routeConversation(input: {
	inference: InferencePort;
	requestId: string;
	messages: Parameters<InferencePort["answer"]>[0];
	tools: NativeTool[];
	cards: ToolchainCard[];
	openQuestions: OpenQuestion[];
	sessions?: SessionOffers;
	signal: AbortSignal;
}): Promise<{
	decision: "toolchain" | "answer";
	operation?: ConversationOperation;
	receipt: Receipt;
}> {
	if (!input.inference.executeControl)
		throw new Error("conversation_routing_unavailable");
	const functions = input.tools.map((tool) => ({
		name: tool.function.name,
		description: tool.function.description,
	}));
	const policy =
		systemContext("dialogue.contexts.conversation-routing.policy", {}) +
		JSON.stringify(functions) +
		"\nOPEN_QUESTIONS=" +
		JSON.stringify(input.openQuestions) +
		"\nOUTPUT_SCHEMA=" +
		JSON.stringify(outputSchemaFor(!!input.sessions?.size));
	const receipt = await input.inference.executeControl(
		input.requestId,
		[{ role: "system", content: policy }, ...input.messages],
		input.signal,
	);
	let parsed: z.infer<typeof routeSchema>;
	try {
		parsed = routeSchema.parse(parseLlmJson(receipt.value));
	} catch {
		throw new Error("invalid_conversation_route");
	}
	if (parsed.decision !== "toolchain") {
		if (parsed.functionName || parsed.request || parsed.questionRef)
			throw new Error("invalid_conversation_route");
		return { decision: parsed.decision, receipt };
	}
	try {
		const selected = operation(
			[
				{
					id: input.requestId,
					name: parsed.functionName,
					arguments: JSON.stringify({
						request: parsed.request,
						...(parsed.questionRef ? { questionRef: parsed.questionRef } : {}),
						...(parsed.target ? { target: parsed.target } : {}),
						...(parsed.resolveUnsaved
							? { resolveUnsaved: parsed.resolveUnsaved }
							: {}),
					}),
				},
			],
			input.tools,
			input.cards,
			input.openQuestions,
			input.sessions,
		);
		return { decision: "toolchain", operation: selected, receipt };
	} catch {
		throw new Error("invalid_conversation_route");
	}
}

/** Recheck prose when a model declined every offered function. */
export async function reviewConversationAnswer(
	deps: DialogueDeps,
	run: Run,
	input: GenerateInput,
	decision: Awaited<ReturnType<typeof prepareDecision>>,
	signal: AbortSignal,
): Promise<{
	operation?: ConversationOperation;
	receipt?: Receipt;
	selection?: SelectionDraft;
}> {
	const { larm, store } = deps;
	if (
		!decision.tools?.length ||
		!decision.cards?.length ||
		!input.routing ||
		input.agent ||
		!larm.captureControlInTransaction ||
		!larm.executeControl
	)
		return {};
	const requestId = await store.write((tx) =>
		larm.captureControlInTransaction!(tx, {
			subject: `dialogue:${input.runId}:route:${crypto.randomUUID()}`,
			policySubject: input.runId,
			deadline: Date.parse(run.deadlineAt!),
			maxOutputTokens: 512,
		}),
	);
	let route: Awaited<ReturnType<typeof routeConversation>>;
	try {
		route = await routeConversation({
			inference: larm,
			requestId,
			messages: decision.selectionMessages ?? decision.messages,
			tools: decision.tools,
			cards: decision.cards,
			openQuestions: decision.openQuestions,
			sessions: decision.sessions,
			signal,
		});
	} catch (error) {
		if (
			error instanceof Error &&
			error.message === "invalid_conversation_route"
		) {
			await recordRejected(deps, input.runId, decision.draft);
			throw new Error("invalid_conversation_operation");
		}
		throw error;
	}
	if (route.operation)
		return {
			operation: route.operation,
			receipt: route.receipt,
			selection: chosen(decision, {
				operation: route.operation,
				repaired: false,
			}),
		};
	await store.write((tx) =>
		larm.rejectControlInTransaction?.(tx, route.receipt, "route_to_response"),
	);
	return {};
}
