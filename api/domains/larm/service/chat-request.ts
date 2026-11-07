import { imageMessageParts } from "../../../infrastructure/chat-image-parts";
import type { LarmPort, LarmCallOptions } from "../contracts";
import { nativeToolOptions } from "../../../infrastructure/chat-stream";
import { operationSchema } from "./operation-schema";
import type { Provider } from "./profiles";

type OutputWindow = Pick<
	NonNullable<Provider["contextWindow"]>,
	"outputReserveTokens" | "outputLimit"
>;

/** A legacy claim caps output at its reserve; remaining-context uses the request and the formal input check. */
export function sentMaxTokens(
	window: OutputWindow,
	options: Pick<LarmCallOptions, "maxOutputTokens"> | undefined,
): number {
	const requested = options?.maxOutputTokens ?? 4096;
	return window.outputLimit === "remaining-context"
		? requested
		: Math.min(window.outputReserveTokens, requested);
}

export function chatRequest(
	provider: { model: string; contextWindow?: OutputWindow },
	messages: Parameters<LarmPort["answer"]>[0],
	stream: boolean,
	options?: LarmCallOptions,
) {
	return {
		model: provider.model,
		...(options?.promptCacheKey
			? { prompt_cache_key: options.promptCacheKey }
			: {}),
		messages: messages.map(imageMessageParts),
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
		// Absent: nothing is sent and the served model's own default applies. Off is an effort too: a provider that
		// requires reasoning takes `none` from `reasoning_effort`, not from the template switch.
		...(options?.reasoning === "off"
			? {
					chat_template_kwargs: { enable_thinking: false },
					reasoning_effort: "none",
				}
			: options?.reasoning
				? {
						chat_template_kwargs: { enable_thinking: true },
						reasoning_effort: options.reasoning,
					}
				: {}),
		stream,
		max_tokens: sentMaxTokens(provider.contextWindow!, options),
	};
}
