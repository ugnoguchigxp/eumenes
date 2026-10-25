import sharp from "sharp";
import * as bmp from "bmp-ts";
import { readBounded } from "./bounded-read";
export type MediaImage = {
	mime: "image/png" | "image/jpeg" | "image/bmp";
	bytes: Uint8Array;
	width: number;
	height: number;
	timestamp: number | null;
};
export async function imageForInput(
	bytes: Uint8Array,
	timestamp: number | null,
	signal: AbortSignal,
	acceptedMimeTypes: MediaImage["mime"][],
	maxBytes: number,
	maxPixels = 64_000_000,
): Promise<MediaImage> {
	let mime: MediaImage["mime"] | null = acceptedMimeTypes.includes("image/png")
		? "image/png"
		: acceptedMimeTypes.includes("image/jpeg")
			? "image/jpeg"
			: acceptedMimeTypes.includes("image/bmp")
				? "image/bmp"
				: null;
	if (!mime) throw new Error("ocr_correction_vision_unavailable");
	let source = bytes;
	let actualTimestamp: number | null = null;
	if (timestamp !== null) {
		const proc = Bun.spawn(
			[
				"ffmpeg",
				"-hide_banner",
				"-nostdin",
				"-loglevel",
				"info",
				// Container formats can reference files or URLs; only the piped bytes may be read.
				"-protocol_whitelist",
				"pipe",
				"-i",
				"pipe:0",
				"-vf",
				`select=gte(t\\,${timestamp}),showinfo`,
				"-frames:v",
				"1",
				"-f",
				"image2pipe",
				"-vcodec",
				"png",
				"pipe:1",
			],
			{ stdin: bytes, stdout: "pipe", stderr: "pipe", signal },
		);
		let output: Uint8Array;
		let diagnostics: Uint8Array;
		try {
			[output, diagnostics] = await Promise.all([
				readBounded(proc.stdout, {
					limit: 16 * 1024 * 1024,
					tooLarge: "ocr_correction_frame_too_large",
					missing: "ocr_correction_frame_unavailable",
					signal,
				}),
				readBounded(proc.stderr, {
					limit: 128 * 1024,
					tooLarge: "ocr_correction_frame_unavailable",
					missing: "ocr_correction_frame_unavailable",
					signal,
				}),
			]);
		} catch (error) {
			proc.kill();
			throw error;
		}
		const times = [
			...new TextDecoder()
				.decode(diagnostics)
				.matchAll(/pts_time:([0-9]+(?:\.[0-9]+)?)/g),
		].map((m) => Number(m[1]));
		const actual = times.at(-1);
		if (
			(await proc.exited) !== 0 ||
			!output.length ||
			actual === undefined ||
			Math.abs(actual - timestamp) > 0.25
		)
			throw new Error("ocr_correction_frame_unavailable");
		source = output;
		actualTimestamp = actual;
	}
	if (signal.aborted) throw new Error("cancelled");
	const metadata = await sharp(source, {
		limitInputPixels: 64_000_000,
	}).metadata();
	if (
		!metadata.width ||
		!metadata.height ||
		metadata.width * metadata.height > maxPixels
	)
		throw new Error("ocr_correction_image_too_large");
	const normalized = sharp(source, {
		failOn: "error",
		limitInputPixels: 64_000_000,
	})
		.rotate()
		.flatten({ background: "#ffffff" })
		.toColourspace("srgb");
	let converted: Buffer;
	let width: number;
	let height: number;
	if (mime === "image/bmp") {
		const raw = await normalized.raw().toBuffer({ resolveWithObject: true });
		width = raw.info.width;
		height = raw.info.height;
		if (width * height * 3 + 54 > maxBytes)
			throw new Error("ocr_correction_image_too_large");
		const abgr = Buffer.alloc(width * height * 4);
		for (let i = 0, j = 0; j < abgr.length; i += raw.info.channels, j += 4) {
			abgr[j] = 255;
			abgr[j + 1] = raw.data[i + 2]!;
			abgr[j + 2] = raw.data[i + 1]!;
			abgr[j + 3] = raw.data[i]!;
		}
		converted = bmp.encode({ data: abgr, width, height, bitPP: 24 }).data;
	} else {
		let result = await (
			mime === "image/png"
				? normalized.clone().png()
				: normalized.clone().jpeg({ quality: 95 })
		).toBuffer({ resolveWithObject: true });
		if (
			mime === "image/png" &&
			result.data.length > maxBytes &&
			acceptedMimeTypes.includes("image/jpeg")
		) {
			result = await normalized
				.clone()
				.jpeg({ quality: 95 })
				.toBuffer({ resolveWithObject: true });
			mime = "image/jpeg";
		}
		converted = result.data;
		width = result.info.width;
		height = result.info.height;
	}
	if (!width || !height) throw new Error("ocr_correction_image_invalid");
	if (converted.length > maxBytes)
		throw new Error("ocr_correction_image_too_large");
	return {
		mime,
		bytes: new Uint8Array(converted),
		width,
		height,
		timestamp: actualTimestamp,
	};
}
