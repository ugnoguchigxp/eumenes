import type { ReplyMessage } from "eumenes-agency";
import { withGoalReplyTools } from "eumenes-agency/agenda/runtime";
import { systemContext } from "../../infrastructure/system-context";

type JsonObject = Record<string, unknown>;

const GOAL_DESCRIPTIONS: Record<
	string,
	{ description: string; props?: Record<string, string> }
> = {
	list_goals: {
		description: "目標10枠（空き枠含む）の状態・現行版・許可・設計書IDを読む。",
	},
	register_goal: {
		description:
			"明示依頼された目標を保存（優先度未指定は priority: null、status: registered で完了）。",
		props: {
			slot: "指定枠番号（未指定は null）",
			desiredState: "達成目標と達成条件（対象・文言・制約を省かない）",
			quote: "今回発話の明示依頼を原文引用",
		},
	},
	update_goal: {
		description:
			"既存目標の現行版でモック許可/取消・改訂・取下げ・枠解放を行う。",
		props: {
			design:
				"authorize_mock 対象の設計書（list_goals の designNoteId/designDigest。不要時は null）",
			desiredState: "改訂後の目標と条件（不要時は null）",
			quote: "今回発話の明示依頼・許可を原文引用",
		},
	},
};

function stripSchemaNoise(node: unknown): unknown {
	if (Array.isArray(node)) return node.map(stripSchemaNoise);
	if (!node || typeof node !== "object") return node;
	const out: JsonObject = {};
	for (const [key, value] of Object.entries(node as JsonObject)) {
		if (key === "$schema") continue;
		if (key === "maximum" && value === Number.MAX_SAFE_INTEGER) continue;
		out[key] =
			key === "anyOf" && Array.isArray(value)
				? value.map((branch) => {
						const cleaned = stripSchemaNoise(branch);
						if (
							cleaned &&
							typeof cleaned === "object" &&
							!Array.isArray(cleaned)
						) {
							const { description: _d, ...rest } = cleaned as JsonObject;
							return rest;
						}
						return cleaned;
					})
				: stripSchemaNoise(value);
	}
	return out;
}

function compactParameters(
	raw: Record<string, unknown>,
	propDescriptions?: Record<string, string>,
): Record<string, unknown> {
	const cleaned = stripSchemaNoise(raw) as JsonObject;
	if (
		!propDescriptions ||
		typeof cleaned.properties !== "object" ||
		!cleaned.properties
	)
		return cleaned;
	const properties: JsonObject = {};
	for (const [key, value] of Object.entries(cleaned.properties as JsonObject)) {
		if (
			propDescriptions[key] &&
			value &&
			typeof value === "object" &&
			!Array.isArray(value)
		) {
			properties[key] = {
				...(value as JsonObject),
				description: propDescriptions[key],
			};
		} else {
			properties[key] = value;
		}
	}
	return { ...cleaned, properties };
}

/**
 * Compact goal rules appended statically to the system prompt so the KV cache stays stable across goal registration.
 */
export function goalReplyInstructions(
	messages: ReplyMessage[],
	registeredWork = false,
): ReplyMessage[] {
	const [system, ...rest] = messages;
	if (!system || system.role !== "system") return messages;
	const rules =
		systemContext("dialogue.contexts.agency.goal-reply", {}) +
		(registeredWork
			? "\n" + systemContext("dialogue.contexts.agency.goal-work", {})
			: "");
	return [{ ...system, content: `${system.content}\n\n${rules}` }, ...rest];
}

/** All three goal tools kept statically in the KV cache with compact schemas (identical validation and runtime behavior). */
export function goalReplyTools(
	...args: Parameters<typeof withGoalReplyTools>
): ReturnType<typeof withGoalReplyTools> {
	const port = withGoalReplyTools(...args);
	return {
		...port,
		tools: port.tools.map((tool) => {
			const spec = GOAL_DESCRIPTIONS[tool.name];
			if (!spec) return tool;
			const parameters = compactParameters(tool.parameters, spec.props);
			return {
				...tool,
				description: args[4] ? tool.description : spec.description,
				parameters:
					tool.name === "update_goal" ? withoutAnswer(parameters) : parameters,
			};
		}),
	};
}

/**
 * A goal's question reaches the agent as its assignment's (`assignments`), and is answered with `assignment`:
 * `update_goal` does not offer answering it as well.
 */
function withoutAnswer(parameters: Record<string, unknown>) {
	const properties = { ...(parameters.properties as JsonObject) };
	const action = properties.action as JsonObject | undefined;
	if (Array.isArray(action?.enum))
		properties.action = {
			...action,
			enum: action.enum.filter((value) => value !== "answer_question"),
		};
	delete properties.questionRef;
	return {
		...parameters,
		properties,
		...(Array.isArray(parameters.required) && {
			required: parameters.required.filter((key) => key !== "questionRef"),
		}),
	};
}
