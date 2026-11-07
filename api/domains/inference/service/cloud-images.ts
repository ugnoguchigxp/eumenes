import sharp from "sharp";
import * as bmp from "bmp-ts";
import type { Messages, ConnectionModels } from "../contracts";
import type { Connection, Resource } from "../../settings";
import type { ConnectionModelsService } from "./connection-models";

/** Host transfer bounds derived from the existing 8 x 3 MiB attachment allowance; not a tokenizer. */
export const CLOUD_IMAGE_LIMITS = {
	maxImages: 8,
	maxBytes: 3 * 1024 * 1024,
	maxDimension: 8192,
	maxPixels: 16 * 1024 * 1024,
	maxAspect: 100,
	// Bound the complete request to the maximum Base64 attachment allowance (32 MiB).
	maxRequestBytes: (8 * 3 * 1024 * 1024 * 4) / 3,
};

export function imageSupport(
	catalog: ConnectionModels | null,
	resource: Resource,
) {
	const modalities = catalog?.models.find(
		(model) => model.id === resource.model,
	)?.inputModalities;
	return modalities
		? modalities.includes("image")
			? "supported"
			: "unsupported"
		: "unknown";
}

/** No image-bearing message is trimmed; format conversion preserves normalized pixels. */
export async function cloudImages(
	messages: Messages,
	connection: Connection,
	resource: Resource,
	models: ConnectionModelsService | undefined,
	signal: AbortSignal,
): Promise<Messages> {
	signal.throwIfAborted();
	if (!messages.some((m) => m.images?.length)) return messages;
	let count = 0;
	for (const message of messages)
		for (const image of message.images ?? []) {
			if (message.role !== "user") throw new Error("image_role_unsupported");
			if (++count > CLOUD_IMAGE_LIMITS.maxImages)
				throw new Error("image_count_exceeded");
			if (!image.bytes.length) throw new Error("image_invalid");
			if (image.bytes.length > CLOUD_IMAGE_LIMITS.maxBytes)
				throw new Error("image_too_large");
			if (
				!Number.isSafeInteger(image.width) ||
				!Number.isSafeInteger(image.height) ||
				image.width < 1 ||
				image.height < 1 ||
				image.width >
					Math.min(
						CLOUD_IMAGE_LIMITS.maxDimension,
						connection.kind === "claude-agent-sdk" ? 8000 : 8192,
					) ||
				image.height >
					Math.min(
						CLOUD_IMAGE_LIMITS.maxDimension,
						connection.kind === "claude-agent-sdk" ? 8000 : 8192,
					) ||
				image.width * image.height > CLOUD_IMAGE_LIMITS.maxPixels ||
				Math.max(image.width / image.height, image.height / image.width) >
					CLOUD_IMAGE_LIMITS.maxAspect
			)
				throw new Error("image_dimensions_exceeded");
		}
	const support = imageSupport(
		(await models?.list(connection.id, signal)) ?? null,
		resource,
	);
	if (support !== "supported")
		throw new Error(
			support === "unsupported"
				? "image_not_supported"
				: "image_capability_unknown",
		);
	const result: Messages = [];
	for (const message of messages) {
		const images = [];
		for (const image of message.images ?? []) {
			signal.throwIfAborted();
			if (image.mime === "image/bmp") {
				const decoded = bmp.decode(Buffer.from(image.bytes), { toRGBA: true });
				if (decoded.width !== image.width || decoded.height !== image.height)
					throw new Error("image_invalid");
				// The stored BMP is normalized 24-bit; its reserved alpha byte is opaque.
				for (let i = 3; i < decoded.data.length; i += 4) decoded.data[i] = 255;
				const bytes = await sharp(decoded.data, {
					raw: { width: image.width, height: image.height, channels: 4 },
				})
					.removeAlpha()
					.png()
					.toBuffer();
				if (bytes.length > CLOUD_IMAGE_LIMITS.maxBytes)
					throw new Error("image_too_large");
				images.push({ ...image, mime: "image/png" as const, bytes });
			} else if (image.mime === "image/jpeg" || image.mime === "image/png")
				images.push(image);
			else throw new Error("image_format_unsupported");
		}
		result.push(message.images?.length ? { ...message, images } : message);
	}
	signal.throwIfAborted();
	return result;
}

export function checkImageRequest(body: unknown) {
	if (
		Buffer.byteLength(JSON.stringify(body)) > CLOUD_IMAGE_LIMITS.maxRequestBytes
	)
		throw new Error("body_too_large");
}
