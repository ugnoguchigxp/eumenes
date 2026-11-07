/** Backend-only image data, already normalized and authorized by its owner. */
export type MessageImage = {
	mime: "image/jpeg" | "image/png" | "image/bmp";
	bytes: Uint8Array;
	width: number;
	height: number;
};
export function imageDataUrl(image: MessageImage) {
	return `data:${image.mime};base64,${Buffer.from(image.bytes).toString("base64")}`;
}
/** Only message parts are shared; provider options and budget contracts stay with their adapters. */
export function imageMessageParts<
	T extends {
		role: string;
		content: string;
		images?: MessageImage[];
		tool_calls?: unknown;
		tool_call_id?: string;
	},
>(message: T) {
	const { images, role, content, tool_calls, tool_call_id } = message;
	const rest = {
		role,
		content,
		...(tool_calls ? { tool_calls } : {}),
		...(tool_call_id ? { tool_call_id } : {}),
	};
	if (!images?.length) return rest;
	return {
		...rest,
		content: [
			...(message.content
				? [{ type: "text" as const, text: message.content }]
				: []),
			...images.map((image) => ({
				type: "image_url" as const,
				image_url: { url: imageDataUrl(image) },
			})),
		],
	};
}
