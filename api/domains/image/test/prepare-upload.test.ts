import { expect, test } from "bun:test";
import sharp from "sharp";
import { sha256Hex } from "../../../infrastructure/digest";
import {
	prepareImageUpload,
	imageUploadLimits,
} from "../service/prepare-upload";

const live = new AbortController().signal;
const image = (width: number, height: number, alpha = 1) =>
	sharp({
		create: {
			width,
			height,
			channels: 4,
			background: { r: 40, g: 100, b: 180, alpha },
		},
	});

test("large uploads become smaller lossy WebP at at most 2000px, keeping aspect ratio", async () => {
	const width = 2400,
		height = 1200;
	const pixels = Buffer.alloc(width * height * 3);
	let state = 123456789;
	for (let i = 0; i < pixels.length; i++) {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		pixels[i] = state & 255;
	}
	const source = await sharp(pixels, { raw: { width, height, channels: 3 } })
		.png()
		.toBuffer();
	const result = await prepareImageUpload(source, "image/png", live);
	expect(result).toMatchObject({
		width: 2000,
		height: 1000,
		mimeType: "image/webp",
		format: "webp",
	});
	expect(result.bytes.length).toBeLessThan(source.length / 2);
	expect(result.sha256).toBe(sha256Hex(result.bytes));
	// A lossy WebP has a VP8 image chunk, rather than VP8L's lossless stream.
	expect(Buffer.from(result.bytes).includes(Buffer.from("VP8 "))).toBe(true);
	expect((await sharp(Buffer.from(result.bytes)).metadata()).format).toBe(
		"webp",
	);
});

test("orientation is applied before fitting; private metadata is removed", async () => {
	const source = await image(3000, 1500)
		.jpeg()
		.withMetadata({ orientation: 6, exif: { IFD0: { Copyright: "private" } } })
		.toBuffer();
	const result = await prepareImageUpload(source, "image/jpeg", live);
	expect([result.width, result.height]).toEqual([1000, 2000]);
	const meta = await sharp(Buffer.from(result.bytes)).metadata();
	expect(meta.orientation).toBeUndefined();
	expect(meta.exif).toBeUndefined();
	expect(meta.icc).toBeUndefined();
	expect(meta.xmp).toBeUndefined();
	expect(Buffer.from(result.bytes).includes("private")).toBe(false);
});

test("small and boundary images are not enlarged; PNG transparency survives", async () => {
	const source = await image(100, 50, 0.5).png().toBuffer();
	const result = await prepareImageUpload(source, "image/png", live);
	expect([result.width, result.height]).toEqual([100, 50]);
	const { data, info } = await sharp(Buffer.from(result.bytes))
		.raw()
		.toBuffer({ resolveWithObject: true });
	expect(info.channels).toBe(4);
	expect(data[3]).toBeGreaterThanOrEqual(127);
	expect(data[3]).toBeLessThanOrEqual(128);
	const edge = await prepareImageUpload(
		await image(2000, 2000).webp().toBuffer(),
		"image/webp",
		live,
	);
	expect([edge.width, edge.height]).toEqual([2000, 2000]);
});

test("broken, disguised, animated and oversized original files are refused before upload", async () => {
	const png = await image(20, 10).png().toBuffer();
	await expect(prepareImageUpload(png, "image/jpeg", live)).rejects.toThrow(
		"image_mime_mismatch",
	);
	await expect(
		prepareImageUpload(png.subarray(0, 25), "image/png", live),
	).rejects.toThrow("image_invalid");
	await expect(
		prepareImageUpload(
			Buffer.from(
				'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>',
			),
			"image/svg+xml",
			live,
		),
	).rejects.toThrow("image_format_unsupported");
	const frames = Buffer.alloc(2 * 2 * 4 * 2, 120);
	frames.fill(240, 16);
	const animated = await sharp(frames, {
		raw: { width: 2, height: 4, channels: 4, pageHeight: 2 },
	})
		.webp({ loop: 0, delay: [100, 100] })
		.toBuffer();
	expect((await sharp(animated).metadata()).pages).toBe(2);
	await expect(
		prepareImageUpload(animated, "image/webp", live),
	).rejects.toThrow("image_format_unsupported");
	await expect(
		prepareImageUpload(
			new Uint8Array(imageUploadLimits.maxInputBytes + 1),
			"image/png",
			live,
		),
	).rejects.toThrow("image_too_large");
	await expect(
		prepareImageUpload(
			await image(8193, 1).png().toBuffer(),
			"image/png",
			live,
		),
	).rejects.toThrow("image_dimensions_exceeded");
});

test("cancellation never produces upload bytes", async () => {
	const aborted = AbortSignal.abort();
	await expect(
		prepareImageUpload(
			await image(10, 10).png().toBuffer(),
			"image/png",
			aborted,
		),
	).rejects.toThrow();
});
