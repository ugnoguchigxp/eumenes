import sharp, { type Sharp } from "sharp";
import * as bmp from "bmp-ts";
import { attachmentLimits as cap } from "../contracts/attachments";

function dimensions(width: number, height: number) {
	if (
		!Number.isInteger(width) ||
		!Number.isInteger(height) ||
		width < 1 ||
		height < 1
	)
		throw new Error("image_invalid");
	if (
		width > cap.maxDimension ||
		height > cap.maxDimension ||
		width * height > cap.maxPixels ||
		Math.max(width / height, height / width) > cap.maxAspect
	)
		throw new Error("image_dimensions_exceeded");
}

/** Fully decode before accepting. EXIF rotation and white alpha composition match preview and inference. */
export async function normalizeImage(raw: Uint8Array, declaredMime: string) {
	if (!raw.length) throw new Error("image_invalid");
	if (raw.length > cap.maxBytes) throw new Error("image_too_large");
	const buffer = Buffer.from(raw);
	const isBmp = buffer.subarray(0, 2).toString() === "BM";
	let pipeline: Sharp;
	let originalMime: "image/jpeg" | "image/png" | "image/bmp";
	try {
		if (isBmp) {
			if (buffer.length < 26) throw new Error("image_invalid");
			const dib = buffer.readUInt32LE(14);
			if (![12, 40, 56, 108, 124].includes(dib) || buffer.length < 14 + dib)
				throw new Error("image_invalid");
			const w = dib === 12 ? buffer.readUInt16LE(18) : buffer.readInt32LE(18);
			const h =
				dib === 12 ? buffer.readUInt16LE(20) : Math.abs(buffer.readInt32LE(22));
			dimensions(w, h);
			const bpp = buffer.readUInt16LE(dib === 12 ? 24 : 28);
			const compression = dib === 12 ? 0 : buffer.readUInt32LE(30);
			if (![1, 4, 8, 16, 24, 32].includes(bpp) || ![0, 3].includes(compression))
				throw new Error("image_format_unsupported");
			const end = buffer.readUInt32LE(10) + Math.ceil((w * bpp) / 32) * 4 * h;
			if (end > buffer.length || buffer.readUInt32LE(2) > buffer.length)
				throw new Error("image_invalid");
			const decoded = bmp.decode(buffer, { toRGBA: true });
			// BI_RGB reserves the fourth byte; it is not transparency. Preserve alpha only when the DIB declares an alpha mask.
			if (!(dib >= 56 && buffer.readUInt32LE(66) !== 0))
				for (let i = 3; i < decoded.data.length; i += 4) decoded.data[i] = 255;
			pipeline = sharp(decoded.data, {
				raw: { width: w, height: h, channels: 4 },
				limitInputPixels: cap.maxPixels,
			});
			originalMime = "image/bmp";
		} else {
			pipeline = sharp(buffer, {
				limitInputPixels: false,
				failOn: "warning",
			});
			const meta = await pipeline.metadata();
			if (meta.format !== "jpeg" && meta.format !== "png")
				throw new Error("image_format_unsupported");
			dimensions(meta.width ?? 0, meta.height ?? 0);
			originalMime = meta.format === "jpeg" ? "image/jpeg" : "image/png";
		}
		if (
			declaredMime &&
			declaredMime !== originalMime &&
			!(declaredMime === "image/x-ms-bmp" && originalMime === "image/bmp")
		)
			throw new Error("image_mime_mismatch");
		const normalized = pipeline
			.rotate()
			.flatten({ background: "#ffffff" })
			.toColourspace("srgb");
		const preview = await normalized
			.clone()
			.png()
			.toBuffer({ resolveWithObject: true });
		dimensions(preview.info.width, preview.info.height);
		let bytes: Buffer;
		if (originalMime === "image/jpeg")
			bytes = await normalized.jpeg({ quality: 95 }).toBuffer();
		else if (originalMime === "image/bmp") {
			const rgb = await normalized.raw().toBuffer();
			const abgr = Buffer.alloc(preview.info.width * preview.info.height * 4);
			for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
				abgr[j] = 255;
				abgr[j + 1] = rgb[i + 2]!;
				abgr[j + 2] = rgb[i + 1]!;
				abgr[j + 3] = rgb[i]!;
			}
			bytes = bmp.encode({
				data: abgr,
				width: preview.info.width,
				height: preview.info.height,
				bitPP: 24,
			}).data;
		} else bytes = preview.data;
		if (bytes.length > cap.maxBytes) throw new Error("image_too_large");
		return {
			bytes,
			preview: preview.data,
			mime: originalMime,
			originalMime,
			width: preview.info.width,
			height: preview.info.height,
		};
	} catch (error) {
		if (error instanceof Error && /^image_[a-z_]+$/.test(error.message))
			throw error;
		throw new Error("image_invalid");
	}
}
