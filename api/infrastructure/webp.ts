import sharp from "sharp";
import { sha256Hex } from "./digest";

export type EncodedWebp = {
	bytes: Uint8Array;
	width: number;
	height: number;
	sha256: string;
};

/** Encoding policy shared by saved browser captures and uploaded images. */
const WEBP_OPTIONS = {
	quality: 75,
	lossless: false,
	nearLossless: false,
	effort: 6,
} as const;

/** RIFF chunk fourcc list; the decoder below also verifies the pixel stream. */
function webpChunks(bytes: Uint8Array): string[] {
	const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (
		view.length < 20 ||
		view.toString("latin1", 0, 4) !== "RIFF" ||
		view.toString("latin1", 8, 12) !== "WEBP" ||
		view.readUInt32LE(4) + 8 !== view.length
	)
		throw new Error("image_invalid");
	const chunks: string[] = [];
	let offset = 12;
	while (offset + 8 <= view.length) {
		chunks.push(view.toString("latin1", offset, offset + 4));
		offset +=
			8 + view.readUInt32LE(offset + 4) + (view.readUInt32LE(offset + 4) % 2);
	}
	if (offset !== view.length) throw new Error("image_invalid");
	return chunks;
}

export function createWebpCodec(options: {
	maxInputPixels: number;
	maxEdge?: number;
	autoOrient?: boolean;
}) {
	async function inspectWebp(bytes: Uint8Array) {
		const chunks = webpChunks(bytes);
		let size: { width: number; height: number };
		try {
			const { data, info } = await sharp(Buffer.from(bytes), {
				limitInputPixels: options.maxInputPixels,
				failOn: "error",
			})
				.raw()
				.toBuffer({ resolveWithObject: true });
			if (!data.length) throw new Error("image_invalid");
			size = { width: info.width, height: info.height };
		} catch {
			throw new Error("image_invalid");
		}
		return {
			bytes,
			...size,
			sha256: sha256Hex(bytes),
			lossy: chunks.includes("VP8 ") && !chunks.includes("VP8L"),
		};
	}
	return {
		async encodeWebp(
			input: Uint8Array,
			signal: AbortSignal,
		): Promise<EncodedWebp> {
			signal.throwIfAborted();
			let bytes: Uint8Array;
			try {
				let pipeline = sharp(Buffer.from(input), {
					limitInputPixels: options.maxInputPixels,
					failOn: "error",
				});
				if (options.autoOrient) pipeline = pipeline.rotate();
				if (options.maxEdge)
					pipeline = pipeline.resize({
						width: options.maxEdge,
						height: options.maxEdge,
						fit: "inside",
						withoutEnlargement: true,
					});
				bytes = await pipeline.webp(WEBP_OPTIONS).toBuffer();
			} catch {
				throw new Error("image_encode_failed");
			}
			signal.throwIfAborted();
			const result = await inspectWebp(bytes);
			signal.throwIfAborted();
			return {
				bytes: result.bytes,
				width: result.width,
				height: result.height,
				sha256: result.sha256,
			};
		},
		inspectWebp,
	};
}
