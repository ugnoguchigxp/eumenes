import { z } from "zod";
import type { MessageImage } from "./chat-image-parts";

const origin = z.object({
	kind: z.enum([
		"system",
		"history",
		"memory",
		"summary",
		"state",
		"agency",
		"user",
		"notice",
		"tool",
	]),
	id: z.string().optional(),
	revision: z.string().optional(),
	at: z.string().optional(),
	from: z.number().int().nonnegative(),
	to: z.number().int().nonnegative(),
});
export type InputOrigin = Omit<z.infer<typeof origin>, "from" | "to">;

const image = z.object({
	mime: z.string(),
	bytes: z.number(),
	width: z.number(),
	height: z.number(),
});
const message = z.object({
	role: z.string(),
	content: z.string(),
	origins: z.array(origin),
	images: z.array(image).optional(),
	toolCalls: z.unknown().optional(),
	toolCallId: z.string().optional(),
});
export const modelInputSchema = z.object({
	boundary: z.enum(["larm", "cloud-http", "codex-sdk", "claude-agent-sdk"]),
	messages: z.array(message),
	tools: z.unknown().optional(),
	format: z.unknown().optional(),
	maxOutputTokens: z.number().optional(),
	omittedMessages: z.number().int().nonnegative().optional(),
	sdk: z
		.object({
			mode: z.enum(["new", "append", "reset", "resume"]),
			instructions: z.string(),
			prompt: z.string(),
			carried: z.number().int().nonnegative(),
			images: z.array(image),
		})
		.optional(),
});
export type ModelInput = z.infer<typeof modelInputSchema>;
export type ObserveModelInput = (input: ModelInput) => void;

// The reply loop structured-clones its messages. Carry attribution in a cloneable field until inference takes it,
// then use the symbol so request serialization and cache keys see the original message shape.
const origins = Symbol("inputOrigins");
type Mark = z.infer<typeof origin> & { text: string };
type Tagged = { content: string; inputOrigins?: Mark[]; [origins]?: Mark[] };
export function markInput<T extends Tagged>(
	message: T,
	source: InputOrigin,
	from = 0,
	to = message.content.length,
): T {
	message.inputOrigins = [
		...(message.inputOrigins ?? []),
		{ ...source, from, to, text: message.content.slice(from, to) },
	];
	return message;
}

export function copyInputOrigins(
	target: Tagged,
	source: Tagged,
	offset: number,
) {
	for (const { text, from, to, ...origin } of source.inputOrigins ?? [])
		if (target.content.slice(from + offset, to + offset) === text)
			markInput(target, origin, from + offset, to + offset);
}

export function prependInput<T extends Tagged>(message: T, prefix: Tagged): T {
	const merged = {
		...message,
		content: `${prefix.content}\n\n${message.content}`,
	};
	delete merged.inputOrigins;
	copyInputOrigins(merged, prefix, 0);
	copyInputOrigins(merged, message, prefix.content.length + 2);
	return merged;
}

export function modelMessages<T extends Tagged>(messages: T[]): T[] {
	if (!messages.some((message) => message.inputOrigins)) return messages;
	return messages.map((message) => {
		if (!message.inputOrigins) return message;
		const { inputOrigins, ...wire } = message;
		return { ...wire, [origins]: inputOrigins } as T;
	});
}

export const inputImages = (images: readonly MessageImage[]) =>
	images.map(({ mime, width, height, bytes }) => ({
		mime,
		width,
		height,
		bytes: bytes.length,
	}));

export function inputMessages(
	messages: readonly (Tagged & {
		role: string;
		images?: MessageImage[];
		tool_calls?: unknown;
		tool_call_id?: string;
	})[],
): ModelInput["messages"] {
	return messages.map((message) => ({
		role: message.role,
		content: message.content,
		origins: (
			message[origins] ??
			message.inputOrigins ??
			(message.role === "tool"
				? [
						{
							kind: "tool" as const,
							id: message.tool_call_id,
							from: 0,
							to: message.content.length,
							text: message.content,
						},
					]
				: [])
		).flatMap(({ text, ...source }) =>
			message.content.slice(source.from, source.to) === text ? [source] : [],
		),
		...(message.images?.length ? { images: inputImages(message.images) } : {}),
		...(message.tool_calls ? { toolCalls: message.tool_calls } : {}),
		...(message.tool_call_id ? { toolCallId: message.tool_call_id } : {}),
	}));
}

/** An optional observer must never change the result or retry policy of a send. */
export function observeModelInput(
	observer: ObserveModelInput | undefined,
	input: () => ModelInput,
) {
	if (!observer) return;
	try {
		observer(input());
	} catch {
		// Diagnostic details can contain conversation text. The send proceeds independently.
	}
}
