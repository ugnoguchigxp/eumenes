import { createWebpCodec } from "../../../infrastructure/webp";
import type { ImageEncoder, PlannedSize } from "../contracts/ports";

const MAX_INPUT_PIXELS = 2500 * 2500;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Browser-specific header inspection and limits; encoding is shared with uploads. */
export function createWebpEncoder(): ImageEncoder {
	const codec = createWebpCodec({ maxInputPixels: MAX_INPUT_PIXELS });
	return {
		...codec,
		pngSize(png): PlannedSize {
			const view = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
			if (
				view.length < 24 ||
				!PNG_SIGNATURE.every((byte, i) => view[i] === byte) ||
				view.readUInt32BE(8) !== 13 ||
				view.toString("latin1", 12, 16) !== "IHDR"
			)
				throw new Error("image_invalid");
			const width = view.readUInt32BE(16);
			const height = view.readUInt32BE(20);
			if (width < 1 || height < 1) throw new Error("image_invalid");
			return { width, height };
		},
	};
}
