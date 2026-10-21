import { systemContext } from "../../../infrastructure/system-context";
import type { CallSession, InferencePort, Receipt } from "../../inference";
import type { SpeechPreparation } from "../../delivery";
import { isBriefSpokenReply } from "../../delivery";
import type { NativeTool } from "../../../infrastructure/chat-stream";
import type { ToolchainCard } from "../../capabilities";
import { getLogger } from "../../../infrastructure/logger";
import { ValidationFailure } from "../../../infrastructure/validation-log";
import { conversationOutput } from "./conversation-output";
import { validateAnalysis, type FirstRound } from "./initial-decision";
import {
	operation,
	operationRejection,
	type ConversationOperation,
	type OpenQuestion,
	type SessionOffers,
} from "./conversation-tools";

const log = getLogger("dialogue");

type Messages = Parameters<InferencePort["answer"]>[0];

/**
 * One call; at most one structural correction of a native operation. Without `tools` it is an ordinary
 * answer. With `analysis` one of the first round's functions (a candidate's, `answer`, `report_unavailable`)
 * is the only valid output; otherwise `tools` offers the chosen toolchain's function and a call of it is the
 * only valid output. Prose is never adopted in those two.
 */
export async function generateConversation(input: {
	inference: InferencePort;
	requestId?: string;
	messages: Messages;
	/** The host-selected request; correction data must never become its replacement. */
	requestMessage: Messages[number];
	signal: AbortSignal;
	delta: (text: string) => void;
	preparation?: SpeechPreparation;
	briefReply?: boolean;
	tools?: NativeTool[];
	/** The toolchains behind `tools` (the first round's candidates, the second round's chosen one). */
	cards?: ToolchainCard[];
	/** Open questions a call may answer by `questionRef` (offered to the model with `tools`). */
	openQuestions?: OpenQuestion[];
	/** The session toolchains among `cards` and the saved items each may start from. */
	sessions?: SessionOffers;
	/** The first round: `tools` holds the candidates' functions, `answer` and `report_unavailable`. */
	analysis?: boolean;
	allowDiscovery?: boolean;
	/** A true approval must at least have a preceding assistant exchange to stand on. Meaning is judged by the model. */
	approvalReference?: boolean;
	repair: () => void;
	/**
	 * Session lifetime of every call here, including the structural correction: `main` for the answer generation,
	 * `auxiliary` for the function-selection call whose prose is never adopted as the answer.
	 */
	sessionRole: "main" | "auxiliary";
	/**
	 * Where `messages` splits for a resumed session (`main` calls only; providers without sessions send it whole)
	 * and what the prompt was built from (forgetting one of them revokes the running call).
	 */
	session?: Pick<CallSession, "context" | "refs">;
}): Promise<{
	text: string;
	receipt?: Receipt;
	operation?: ConversationOperation;
	analysis?: FirstRound;
	/** The one structural correction was used. */
	repaired: boolean;
}> {
	const { inference, signal } = input;
	let messages = input.messages;
	const originalMessages = messages;
	const callSession: CallSession = {
		sessionRole: input.sessionRole,
		...(input.sessionRole === "main" && input.session?.context
			? { context: input.session.context }
			: {}),
		...(input.session?.refs ? { refs: input.session.refs } : {}),
	};
	for (let attempt = 0; attempt < 2; attempt++) {
		signal.throwIfAborted();
		const output = conversationOutput(
			input.delta,
			input.tools,
			!!input.tools?.length,
		);
		const receipt =
			input.requestId && inference.executeRequest
				? inference.executeStream
					? await inference.executeStream(
							input.requestId,
							messages,
							signal,
							output.delta,
							input.preparation,
							input.tools,
							callSession,
						)
					: await inference.executeRequest(
							input.requestId,
							messages,
							signal,
							input.preparation,
							callSession,
						)
				: undefined;
		const text = receipt
			? (receipt.value as string)
			: inference.answerStream
				? await inference.answerStream(messages, signal, output.delta)
				: await inference.answer(messages, signal);
		signal.throwIfAborted();
		try {
			if (!receipt?.toolCalls?.length) {
				if (input.analysis) throw operationRejection("analysis_call_required");
				if (input.tools?.length) throw operationRejection("tool_call_required");
				if (input.briefReply && !isBriefSpokenReply(text))
					throw operationRejection("spoken_reply_too_long");
				output.finish(text);
				return { text, receipt, repaired: attempt > 0 };
			}
			if (!input.tools)
				throw operationRejection("tools_not_offered_in_request");
			if (input.analysis) {
				const analysis = validateAnalysis(
					receipt.toolCalls,
					input.cards ?? [],
					input.allowDiscovery,
				);
				if (analysis.approved && input.approvalReference === false)
					throw operationRejection("approval_reference_missing");
				// The notice and the explanation are shown to the user: the same output and spoken-reply checks.
				if (analysis.next === "toolchain")
					conversationOutput(() => {}, input.tools).finish(
						analysis.announcement,
					);
				if (analysis.next === "report_unavailable") {
					if (input.briefReply && !isBriefSpokenReply(analysis.reply))
						throw operationRejection("spoken_reply_too_long");
					conversationOutput(() => {}, input.tools, true).finish(
						analysis.reply,
					);
				}
				if (text.trim()) input.repair();
				return {
					text: analysis.next === "report_unavailable" ? analysis.reply : "",
					receipt,
					analysis,
					repaired: attempt > 0,
				};
			}
			const result = {
				text: "",
				receipt,
				operation: operation(
					receipt.toolCalls,
					input.tools,
					input.cards ?? [],
					input.openQuestions ?? [],
					input.sessions,
				),
				repaired: attempt > 0,
			};
			// Some models announce the call first ("調べますね"). A valid call wins; the
			// streamed preamble is withdrawn and never adopted as an answer.
			if (text.trim()) {
				input.repair();
				log.info("dialogue.operation_preamble_dropped", {
					outputCharacters: text.length,
				});
			}
			return result;
		} catch (error) {
			// Classification, public tool name, call count and validation path/code
			// only; arguments, text and provider output stay out of the log.
			const issues =
				error instanceof ValidationFailure
					? error.issues
					: [{ reason: "unclassified" }];
			for (const issue of issues)
				log.warn("dialogue.operation_rejected", {
					...issue,
					repairAttempt: attempt,
					issueCount: issues.length,
				});
			if (attempt === 1) throw new Error("invalid_conversation_operation");
			input.repair();
			const correction =
				systemContext(
					"dialogue.contexts.conversation-generation.correction",
					{},
				) +
				(input.analysis
					? systemContext(
							"dialogue.contexts.conversation-generation.correction-analysis",
							{},
						)
					: input.tools?.length
						? systemContext(
								"dialogue.contexts.conversation-generation.correction-selection",
								{},
							)
						: systemContext(
								"dialogue.contexts.conversation-generation.correction-3",
								{},
							)) +
				systemContext(
					"dialogue.contexts.conversation-generation.correction-4",
					{},
				);
			const [first, ...rest] = originalMessages;
			messages = [
				{
					role: "system",
					content:
						correction + (first?.role === "system" ? "\n" + first.content : ""),
				},
				...(first?.role === "system" ? rest : originalMessages),
			];
			const requestIndex = messages.indexOf(input.requestMessage);
			if (
				requestIndex !== messages.length - 1 ||
				input.requestMessage.role !== "user"
			)
				throw new Error("run_input_missing");
			// Keep the CURRENT_REQUEST marker next to its original message. Repair
			// material belongs before that host-owned anchor, never after the request.
			const insertAt =
				requestIndex > 1 && messages[requestIndex - 1]?.role === "system"
					? requestIndex - 1
					: requestIndex;
			messages.splice(insertAt, 0, {
				role: "user",
				content:
					"UNTRUSTED_REJECTED_OUTPUT=" +
					JSON.stringify({
						// Bound correction context independently of provider output.
						textPreview: text.slice(0, 4096),
						textTruncated: text.length > 4096,
						toolCalls: (receipt?.toolCalls ?? []).slice(0, 2).map((call) => ({
							name: input.tools?.some((t) => t.function.name === call.name)
								? call.name
								: null,
							argumentsPreview: call.arguments.slice(0, 4096),
							truncated: call.arguments.length > 4096,
						})),
						issues,
					}),
			});
		}
	}
	throw new Error("invalid_conversation_operation");
}
