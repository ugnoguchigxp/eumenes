import type { ChatContentPart } from "../contracts/chat-input";
import type { LarmPort, LarmCallOptions } from "../contracts";
import { nativeToolOptions } from "../../../infrastructure/chat-stream";
import { operationSchema } from "./operation-schema";
export function chatRequest(
	provider: { model: string; contextWindow?: { outputReserveTokens: number } },
	messages: Parameters<LarmPort["answer"]>[0],
	stream: boolean,
	options?: LarmCallOptions,
) {
	return {
		model: provider.model,
		messages: messages.map(
			({ images, role, content: text, tool_calls, tool_call_id }) => {
				const m = {
					role,
					content: text,
					...(tool_calls ? { tool_calls } : {}),
					...(tool_call_id ? { tool_call_id } : {}),
				};
				if (!images?.length) return m;
				const content: ChatContentPart[] = m.content
					? [{ type: "text", text: m.content }]
					: [];
				for (const image of images)
					content.push({
						type: "image_url",
						image_url: {
							url: `data:${image.mime};base64,${Buffer.from(image.bytes).toString("base64")}`,
						},
					});
				return { ...m, content };
			},
		),
		...(options?.jsonOutput
			? {
					temperature: 0,
					response_format: options.jsonSchema
						? {
								type: "json_schema",
								json_schema: {
									name: "control",
									strict: true,
									schema:
										options.toolOutputFormat === "json-schema"
											? operationSchema(options.jsonSchema)
											: options.jsonSchema,
								},
							}
						: { type: "json_object" },
				}
			: {}),
		...nativeToolOptions(
			options?.toolOutputFormat === "json-schema" ? undefined : options?.tools,
			options?.toolChoice,
		),
		// A call offered tools decides on them greedily, a spoken reply too: sampled, the model talks instead of calling.
		...(options?.tools?.length ? { temperature: 0 } : {}),
		// Absent: nothing is sent and the served model's own default applies.
		...(options?.reasoning === "off"
			? { chat_template_kwargs: { enable_thinking: false } }
			: options?.reasoning
				? {
						chat_template_kwargs: { enable_thinking: true },
						reasoning_effort: options.reasoning,
					}
				: {}),
		stream,
		max_tokens: Math.min(
			provider.contextWindow!.outputReserveTokens,
			options?.maxOutputTokens ?? 4096,
		),
	};
}
