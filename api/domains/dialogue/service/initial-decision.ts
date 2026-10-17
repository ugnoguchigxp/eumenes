import type {
	NativeTool,
	NativeToolCall,
} from "../../../infrastructure/chat-stream";
import { parseLlmJson } from "../../../infrastructure/llm-json";
import { z } from "zod";
import { operationRejection } from "./conversation-tools";

/** Discovery is a decision only: it neither selects a specialist nor executes work. */
export const discoveryTool: NativeTool = {
	type: "function",
	function: {
		name: "find_toolchain",
		description:
			"現在の依頼を手元の情報と回答だけでは満たせず、外部情報の確認・操作・制作・専門担当への引継ぎが必要な場合に、利用可能な担当を探します。依頼を満たせる場合は直接回答し、進めるための必須情報が不足していれば必要な確認を返します。この関数は探索だけで実行や担当切替をしません。実行の予告は担当を選定してから行います。",
		parameters: { type: "object", properties: {}, additionalProperties: false },
	},
};

export function validateDiscovery(calls: NativeToolCall[]) {
	if (calls.length !== 1 || calls[0]?.name !== discoveryTool.function.name)
		throw operationRejection("invalid_discovery_call");
	try {
		z.object({}).strict().parse(parseLlmJson(calls[0].arguments));
	} catch {
		throw operationRejection("invalid_discovery_arguments");
	}
}
