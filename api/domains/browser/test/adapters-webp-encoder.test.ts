import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { createWebpEncoder } from "../adapters/webp-encoder";

const encoder = createWebpEncoder();
const live = new AbortController().signal;

/** Noisy test image so lossy and lossless sizes differ clearly. */
async function png(width: number, height: number, extra: object = {}) {
	const raw = Buffer.alloc(width * height * 3);
	for (let i = 0; i < raw.length; i++) raw[i] = (i * 31 + (i >> 3) * 7) & 255;
	return new Uint8Array(
		await sharp(raw, { raw: { width, height, channels: 3 } })
			.png(extra)
			.toBuffer(),
	);
}

function chunks(bytes: Uint8Array) {
	const view = Buffer.from(bytes);
	const names: string[] = [];
	let offset = 12;
	while (offset + 8 <= view.length) {
		names.push(view.toString("latin1", offset, offset + 4));
		offset +=
			8 + view.readUInt32LE(offset + 4) + (view.readUInt32LE(offset + 4) % 2);
	}
	return names;
}

test("pngSize reads the IHDR without decoding and rejects anything else", async () => {
	expect(encoder.pngSize(await png(320, 200))).toEqual({
		width: 320,
		height: 200,
	});
	const header = await png(3, 2);
	// Corrupt everything after IHDR: the size is still readable, so nothing was decoded.
	header.fill(0, 33);
	expect(encoder.pngSize(header)).toEqual({ width: 3, height: 2 });
	expect(() => encoder.pngSize(new Uint8Array(10))).toThrow("image_invalid");
	const bad = await png(3, 2);
	bad[0] = 0;
	expect(() => encoder.pngSize(bad)).toThrow("image_invalid");
	const zero = await png(3, 2);
	zero.fill(0, 16, 20);
	expect(() => encoder.pngSize(zero)).toThrow("image_invalid");
	// Huge declared sizes are reported as they are (the domain rejects them).
	const wide = await png(3, 2);
	Buffer.from(wide.buffer).writeUInt32BE(100000, 16);
	expect(encoder.pngSize(wide).width).toBe(100000);
});

test("encodeWebp makes a lossy, metadata-free WebP at quality 75 with the right hash", async () => {
	const source = await png(640, 480);
	const encoded = await encoder.encodeWebp(source, live);
	expect(encoded.width).toBe(640);
	expect(encoded.height).toBe(480);
	expect(encoded.sha256).toBe(
		createHash("sha256").update(encoded.bytes).digest("hex"),
	);
	expect(chunks(encoded.bytes)).toEqual(["VP8 "]);
	const inspected = await encoder.inspectWebp(encoded.bytes);
	expect(inspected.lossy).toBe(true);
	expect(inspected).toMatchObject({
		width: 640,
		height: 480,
		sha256: encoded.sha256,
	});
	const metadata = await sharp(Buffer.from(encoded.bytes)).metadata();
	expect(metadata.format).toBe("webp");
	expect(metadata.exif).toBeUndefined();
	expect(metadata.icc).toBeUndefined();
	expect(metadata.xmp).toBeUndefined();
	// Quality is the fixed 75: identical to a direct quality-75 encode, different from 90.
	const q75 = await sharp(Buffer.from(source))
		.webp({ quality: 75, effort: 6 })
		.toBuffer();
	const q90 = await sharp(Buffer.from(source))
		.webp({ quality: 90, effort: 6 })
		.toBuffer();
	expect(Buffer.from(encoded.bytes).equals(q75)).toBe(true);
	expect(Buffer.from(encoded.bytes).equals(q90)).toBe(false);
});

test("metadata and an alpha channel in the PNG do not leak into the output", async () => {
	const source = new Uint8Array(
		await sharp({
			create: {
				width: 64,
				height: 64,
				channels: 4,
				background: { r: 10, g: 20, b: 30, alpha: 0.5 },
			},
		})
			.withMetadata({ exif: { IFD0: { Copyright: "secret" } } })
			.png()
			.toBuffer(),
	);
	const encoded = await encoder.encodeWebp(source, live);
	expect(
		chunks(encoded.bytes).filter((name) =>
			["EXIF", "XMP ", "ICCP"].includes(name),
		),
	).toEqual([]);
	expect(Buffer.from(encoded.bytes).includes("secret")).toBe(false);
	expect((await encoder.inspectWebp(encoded.bytes)).lossy).toBe(true);
});

test("inspectWebp flags lossless files and rejects malformed ones", async () => {
	const lossless = new Uint8Array(
		await sharp(Buffer.from(await png(32, 32)))
			.webp({ lossless: true })
			.toBuffer(),
	);
	expect((await encoder.inspectWebp(lossless)).lossy).toBe(false);
	await expect(encoder.inspectWebp(new Uint8Array([1, 2, 3]))).rejects.toThrow(
		"image_invalid",
	);
	const lossy = (await encoder.encodeWebp(await png(64, 64), live)).bytes;
	const truncated = lossy.slice(0, lossy.length - 40);
	await expect(encoder.inspectWebp(truncated)).rejects.toThrow("image_invalid");
	const damaged = new Uint8Array(lossy);
	damaged.fill(0xff, 30, damaged.length);
	await expect(encoder.inspectWebp(damaged)).rejects.toThrow("image_invalid");
});

test("input over the pixel limit is refused before decoding, and an aborted signal stops the work", async () => {
	const huge = await sharp({
		create: { width: 2600, height: 2600, channels: 3, background: "#808080" },
	})
		.png({ compressionLevel: 9 })
		.toBuffer();
	await expect(encoder.encodeWebp(new Uint8Array(huge), live)).rejects.toThrow(
		"image_encode_failed",
	);
	await expect(
		encoder.encodeWebp(new Uint8Array([1, 2, 3]), live),
	).rejects.toThrow("image_encode_failed");
	const aborted = new AbortController();
	aborted.abort();
	await expect(
		encoder.encodeWebp(await png(8, 8), aborted.signal),
	).rejects.toThrow();
	// The limit allows the design's 2,500 x 2,500 maximum.
	const edge = await sharp({
		create: { width: 2500, height: 2500, channels: 3, background: "#808080" },
	})
		.png({ compressionLevel: 9 })
		.toBuffer();
	const encoded = await encoder.encodeWebp(new Uint8Array(edge), live);
	expect(encoded).toMatchObject({ width: 2500, height: 2500 });
});
