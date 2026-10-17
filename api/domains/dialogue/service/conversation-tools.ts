import { systemContext } from "../../../infrastructure/system-context";
import { LlmJsonError, parseLlmJson } from "../../../infrastructure/llm-json";
import { z } from "zod";
import {
	builtinToolchainFunctions,
	toolchainRequest,
	type ToolchainCard,
} from "../../capabilities";
import type {
	NativeTool,
	NativeToolCall,
} from "../../../infrastructure/chat-stream";
import type { LogFields } from "../../../infrastructure/logger";
import {
	ValidationFailure,
	validationIssues,
} from "../../../infrastructure/validation-log";
import type { ChatMessage } from "./context";

/** The one operation the conversation model can choose: hand a request to one toolchain. */
export type ConversationOperation = {
	kind: "toolchain";
	toolchainId: string;
	revisionId: string;
	functionName: string;
	request: string;
	announcement: string;
	/** The open question this request answers (the toolchain asked it earlier). */
	questionRef?: string;
	/** A session toolchain only: the saved item to start from (a host-issued ref). */
	target?: string;
	/** A session toolchain only: the user confirmed dropping the unsaved work of another target. */
	resolveUnsaved?: "discard";
};
/**
 * The session toolchains among the offered cards, by function name, with the saved items each may start
 * from (host-issued refs with a label). A card in it takes `{request, target?, resolveUnsaved?}`.
 */
export type SessionOffers = ReadonlyMap<
	string,
	ReadonlyArray<{ ref: string; label: string }>
>;
/** A question the user has not answered yet, offered to the model as reference data. */
export type OpenQuestion = {
	questionRef: string;
	functionName: string;
	prompt: string;
};
export const announcementSchema = z
	.string()
	.trim()
	.min(1)
	.max(80)
	.describe(
		"選定した担当へ依頼する前に利用者へ伝える短い一文。これから行うことを説明し、完了は断言しない。会話相手が専門担当へ切り替わる関数では、その引継ぎを伝える。",
	);
const announcedRequest = toolchainRequest
	.extend({ announcement: announcementSchema })
	.strict();
const requestSchema = z.toJSONSchema(announcedRequest) as Record<
	string,
	unknown
>;
const requestProperties = requestSchema.properties as Record<string, unknown>;
const delegatedRequestSchema = {
	...requestSchema,
	properties: {
		...requestProperties,
		request: {
			...(requestProperties.request as Record<string, unknown>),
			description:
				"今回の依頼のうち、この担当へ渡す内容。明示された対象名・識別子・地域・日時・数値・単位は原文のまま保持し、省略された対象だけ文脈で補う。",
		},
	},
};
/** A session toolchain's function schema: the request, the saved item to start from, the unsaved-work decision. */
function sessionRequestSchemaFor(
	targets: ReadonlyArray<{ ref: string; label: string }>,
) {
	return {
		...delegatedRequestSchema,
		properties: {
			...delegatedRequestSchema.properties,
			...(targets.length
				? {
						target: {
							type: "string",
							enum: targets.map((t) => t.ref),
							description:
								"保存済みの項目を元に編集を始めるときだけ、その項目のref。候補: " +
								targets
									.map((t) => `${t.ref}=${JSON.stringify(t.label)}`)
									.join("、") +
								"。新しく作るときは省略する。",
						},
					}
				: {}),
			resolveUnsaved: {
				type: "string",
				enum: ["discard"],
				description:
					"別の作業の未保存の変更を破棄して切り替えることを、利用者が明確に承諾した直後の呼出しだけdiscardを指定する。通常は省略する。",
			},
		},
	};
}
/** The `{ request }` function schema, with `questionRef` limited to the refs open for it. */
function requestSchemaFor(refs: string[]) {
	if (!refs.length) return delegatedRequestSchema;
	return {
		...delegatedRequestSchema,
		properties: {
			...delegatedRequestSchema.properties,
			questionRef: {
				type: "string",
				enum: refs,
				description:
					"利用者の今回の発言が、この操作担当の確認質問(openQuestions)への回答である場合だけ、その質問のquestionRefを指定する。新しい依頼では省略する。",
			},
		},
	};
}
/** A session option the model may leave empty: null or "" means not given. */
const unsetEmpty = (v: unknown) => (v === null || v === "" ? undefined : v);
const sessionRequest = z
	.object({
		request: toolchainRequest.shape.request,
		announcement: announcementSchema,
		target: z.preprocess(unsetEmpty, z.string().max(200).optional()),
		resolveUnsaved: z.preprocess(unsetEmpty, z.literal("discard").optional()),
	})
	.strict();
const answeringRequest = z
	.object({
		request: toolchainRequest.shape.request,
		announcement: announcementSchema,
		questionRef: z.string().min(1).max(64),
	})
	.strict();
/**
 * One function per offered toolchain, all with the same `{ request }` argument. The
 * description comes from the registered definition; a redirect names only offered functions.
 * A function whose operation asked a question that is still open also accepts its `questionRef`.
 */
export function toolchainTools(
	cards: ToolchainCard[],
	openQuestions: OpenQuestion[] = [],
	sessions: SessionOffers = new Map(),
): NativeTool[] {
	const offered = new Set(cards.map((c) => c.functionName));
	return cards.map((card) => ({
		type: "function" as const,
		function: {
			name: card.functionName,
			description:
				card.summary +
				(sessions.has(card.functionName)
					? "。会話相手をこの専門担当へ切り替え、以後は直接対話します"
					: "。担当が作業した結果を通常会話へ返します") +
				"。使う場面: " +
				card.useWhen.join("、") +
				"。" +
				card.redirects
					.filter((r) => offered.has(r.functionName))
					.map((r) => `${r.when}には${r.functionName}を使う。`)
					.join(""),
			parameters: sessions.has(card.functionName)
				? sessionRequestSchemaFor(sessions.get(card.functionName)!)
				: requestSchemaFor(
						openQuestions
							.filter((q) => q.functionName === card.functionName)
							.map((q) => q.questionRef),
					),
		},
	}));
}
/** Every function name a toolchain may use, for detecting call syntax written as text. */
export const conversationToolNames = new Set([
	...builtinToolchainFunctions,
	// Names of earlier releases still appear in stored answers and must not be imitated.
	"create_music",
	"open_music_library",
	"delegate_task",
	"research",
]);
/** Rejection with a safe classification only: no arguments, text or unknown names. */
export function operationRejection(
	reason: string,
	call?: NativeToolCall,
	issues: LogFields[] = [],
	count?: number,
) {
	return new ValidationFailure(
		"invalid_conversation_operation",
		(issues.length ? issues : [{}]).map((issue) => ({
			reason,
			...(call
				? {
						controlAction: conversationToolNames.has(call.name)
							? call.name
							: "unknown",
					}
				: {}),
			...(count === undefined ? {} : { count }),
			...issue,
		})),
	);
}
export function operation(
	calls: NativeToolCall[],
	permitted: NativeTool[],
	cards: ToolchainCard[],
	openQuestions: OpenQuestion[] = [],
	sessions: SessionOffers = new Map(),
): ConversationOperation {
	if (calls.length !== 1)
		throw operationRejection("call_count", undefined, [], calls.length);
	const call = calls[0]!;
	const card = cards.find((c) => c.functionName === call.name);
	if (!card || !permitted.some((t) => t.function.name === call.name))
		throw operationRejection("tool_not_offered", call);
	let args: unknown;
	try {
		args = parseLlmJson(call.arguments);
	} catch (error) {
		throw operationRejection(
			"arguments_not_json",
			call,
			error instanceof LlmJsonError
				? [{ validationPath: "arguments", validationCode: error.code }]
				: [],
		);
	}
	const session = sessions.get(card.functionName);
	if (session) {
		const parsed = sessionRequest.safeParse(args);
		if (!parsed.success)
			throw operationRejection(
				"arguments_invalid",
				call,
				validationIssues(parsed.error, args),
			);
		// Only a ref the host issued for this toolchain can be a target.
		if (
			parsed.data.target !== undefined &&
			!session.some((t) => t.ref === parsed.data.target)
		)
			throw operationRejection("target_not_offered", call);
		return {
			kind: "toolchain",
			toolchainId: card.id,
			revisionId: card.revisionId,
			functionName: card.functionName,
			request: parsed.data.request,
			announcement: parsed.data.announcement,
			...(parsed.data.target === undefined
				? {}
				: { target: parsed.data.target }),
			...(parsed.data.resolveUnsaved
				? { resolveUnsaved: "discard" as const }
				: {}),
		};
	}
	const answering =
		!!args &&
		typeof args === "object" &&
		(args as Record<string, unknown>).questionRef !== undefined;
	const result = answering
		? answeringRequest.safeParse(args)
		: announcedRequest.safeParse(args);
	if (!result.success)
		throw operationRejection(
			"arguments_invalid",
			call,
			validationIssues(result.error, args),
		);
	const questionRef = answering
		? (result.data as z.infer<typeof answeringRequest>).questionRef
		: undefined;
	// Only a question that is open for this very function can be answered.
	if (
		questionRef !== undefined &&
		!openQuestions.some(
			(q) =>
				q.questionRef === questionRef && q.functionName === card.functionName,
		)
	)
		throw operationRejection("question_not_open", call);
	return {
		kind: "toolchain",
		toolchainId: card.id,
		revisionId: card.revisionId,
		functionName: card.functionName,
		request: result.data.request,
		announcement: result.data.announcement,
		...(questionRef === undefined ? {} : { questionRef }),
	};
}
/**
 * The fixed layer of the conversation policy: answer, ask, or hand the request to one offered
 * toolchain. How each toolchain works is its own sub-agent's business, never written here.
 */
export function conversationPolicy(offered: boolean) {
	return offered
		? systemContext(
				"dialogue.contexts.conversation-tools.conversation-policy",
				{},
			)
		: systemContext(
				"dialogue.contexts.conversation-tools.conversation-policy-2",
				{},
			);
}
/**
 * Insert the policy and the reference data right before the current user message. Like `markCurrentRequest` it
 * runs in the execute phase: what it inserts (past selections, open questions, whether functions are offered) is
 * decided by the routing, which happens after the prepare phase has rendered the context.
 */
export function appendConversationPolicy(
	messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
	offered: boolean,
	current: ChatMessage,
	pastSelections: Array<{
		request: string;
		functionName: string;
		outcome: string | null;
	}> = [],
	openQuestions: OpenQuestion[] = [],
) {
	let index = messages.indexOf(current);
	if (index < 0) throw new Error("run_input_missing");
	if (pastSelections.length)
		messages.splice(index++, 0, {
			role: "user",
			content:
				systemContext("dialogue.contexts.conversation-tools.content", {}) +
				JSON.stringify(pastSelections),
		});
	if (openQuestions.length)
		messages.splice(index++, 0, {
			role: "user",
			content:
				systemContext("dialogue.contexts.conversation-tools.content-2", {}) +
				JSON.stringify(openQuestions),
		});
	messages.splice(index, 0, {
		role: "system",
		content: conversationPolicy(offered),
	});
}
