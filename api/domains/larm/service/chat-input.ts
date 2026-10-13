import { createHash } from "node:crypto";
import {
	chatInputSchema,
	tokenCountSchema,
	type ChatInput,
} from "../contracts/chat-input";
import { readBounded } from "../../../infrastructure/bounded-read";
import type { Provider } from "./profiles";
import { chatRequest } from "./chat-request";
import type { LarmCallOptions, LarmPort } from "../contracts";

/** Read the deployed contract; never infer image support from model names. */
export function providerChatInput(
	info: Record<string, unknown>,
): ChatInput | undefined {
	const vision =
		Array.isArray(info.supportedCapabilities) &&
		info.supportedCapabilities.includes("llm.vision");
	if (info.chatInput === undefined) {
		if (vision) throw new Error("chat_input_contract_unavailable");
		return undefined;
	}
	const parsed = chatInputSchema.safeParse(info.chatInput);
	if (!parsed.success) throw new Error("chat_input_contract_unavailable");
	return parsed.data;
}

/** Validate normalized images and final wire size, including tools and Base64 overhead. */
export function validatedChatBody(
	p: Provider,
	messages: Parameters<LarmPort["answer"]>[0],
	stream: boolean,
	options?: LarmCallOptions,
) {
	let count = 0;
	for (const m of messages)
		for (const image of m.images ?? []) {
			if (!p.vision || !p.chatInput) throw new Error("image_not_supported");
			if (m.role !== "user") throw new Error("image_role_unsupported");
			const limits = p.chatInput.images;
			if (++count > limits.maxImages) throw new Error("image_count_exceeded");
			if (!limits.mimeTypes.includes(image.mime))
				throw new Error("image_format_unsupported");
			if (image.bytes.length > limits.maxBytes)
				throw new Error("image_too_large");
			if (
				image.width < 1 ||
				image.height < 1 ||
				image.width > limits.maxWidth ||
				image.height > limits.maxHeight ||
				image.width * image.height > limits.maxPixels ||
				Math.max(image.width / image.height, image.height / image.width) >
					limits.maxAspectRatio
			)
				throw new Error("image_dimensions_exceeded");
		}
	const body = chatRequest(p, messages, stream, options);
	const serialized = JSON.stringify(body);
	if (
		p.chatInput &&
		Buffer.byteLength(serialized, "utf8") > p.chatInput.maxRequestBytes
	)
		throw new Error("body_too_large");
	return { body, serialized, count };
}

/** Count precisely the body later sent, using this claim's credential and identity. */
export async function countChatBody(
	p: Provider,
	body: ReturnType<typeof chatRequest>,
	serialized: string,
	count: number,
	signal: AbortSignal,
	send: (url: URL, init: RequestInit) => Promise<Response>,
) {
	if (!p.chatInput) {
		if (count) throw new Error("chat_input_contract_unavailable");
		return;
	}
	const base = new URL(p.baseUrl.replace(/\/$/, "") + "/");
	const url = new URL(p.chatInput.tokenCounting.endpoint, base);
	if (
		url.origin !== base.origin ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	)
		throw new Error("larm_endpoint_mismatch");
	const response = await send(url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${p.token}`,
			"Content-Type": "application/json",
		},
		body: serialized,
		signal,
		redirect: "error",
	});
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error("chat_token_count_unavailable");
	}
	const bytes = await readBounded(response.body, {
		limit: 32768,
		tooLarge: "chat_token_count_unavailable",
		missing: "chat_token_count_unavailable",
		signal,
	});
	let payload: unknown;
	try {
		payload = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		throw new Error("chat_token_count_unavailable");
	}
	const result = tokenCountSchema.safeParse(payload);
	signal.throwIfAborted();
	if (
		!result.success ||
		result.data.requestDigest !==
			createHash("sha256").update(serialized).digest("hex") ||
		result.data.inputBudgetTokens !==
			p.contextWindow!.maxTokens -
				body.max_tokens -
				p.contextWindow!.safetyMarginTokens ||
		result.data.model !== p.model ||
		result.data.imageCount !== count ||
		result.data.requestedOutputTokens !== body.max_tokens ||
		result.data.maxContextTokens !== p.contextWindow?.maxTokens ||
		result.data.safetyMarginTokens !== p.contextWindow?.safetyMarginTokens
	)
		throw new Error("chat_token_count_unavailable");
	if (
		!result.data.fits ||
		result.data.promptTokens > result.data.inputBudgetTokens
	)
		throw new Error("context_budget_exceeded");
}
