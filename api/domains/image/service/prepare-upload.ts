import sharp from "sharp";
import { createWebpCodec } from "../../../infrastructure/webp";

/** Original-file safety limits are separate from the compressed upload size. */
export const imageUploadLimits = {
	maxInputBytes: 16 * 1024 * 1024,
	maxInputEdge: 8192,
	maxInputPixels: 32 * 1024 * 1024,
	maxOutputEdge: 2000,
} as const;

const codec = createWebpCodec({
	maxInputPixels: imageUploadLimits.maxInputPixels,
	maxEdge: imageUploadLimits.maxOutputEdge,
	autoOrient: true,
});
const inputErrors = new Set([
	"image_invalid",
	"image_format_unsupported",
	"image_mime_mismatch",
	"image_dimensions_exceeded",
]);

/** Local files and selected Photos bytes use this same preparation before LARM. */
export async function prepareImageUpload(
	raw: Uint8Array,
	declaredMime: string,
	signal: AbortSignal,
) {
	signal.throwIfAborted();
	if (!raw.length) throw new Error("image_invalid");
	if (raw.length > imageUploadLimits.maxInputBytes)
		throw new Error("image_too_large");
	try {
		const meta = await sharp(Buffer.from(raw), {
			limitInputPixels: false,
			failOn: "warning",
		}).metadata();
		if (!["jpeg", "png", "webp"].includes(meta.format) || (meta.pages ?? 1) > 1)
			throw new Error("image_format_unsupported");
		if (declaredMime && declaredMime !== `image/${meta.format}`)
			throw new Error("image_mime_mismatch");
		const { width, height } = meta;
		if (!width || !height) throw new Error("image_invalid");
		if (
			width > imageUploadLimits.maxInputEdge ||
			height > imageUploadLimits.maxInputEdge ||
			width * height > imageUploadLimits.maxInputPixels
		)
			throw new Error("image_dimensions_exceeded");
		const encoded = await codec.encodeWebp(raw, signal);
		return {
			...encoded,
			mimeType: "image/webp" as const,
			format: "webp" as const,
		};
	} catch (error) {
		signal.throwIfAborted();
		if (error instanceof Error && inputErrors.has(error.message)) throw error;
		throw new Error("image_invalid");
	}
}
