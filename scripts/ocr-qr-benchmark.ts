import { mkdirSync, writeFileSync } from "node:fs";
import sharp from "sharp";
import { prepareZXingModule, writeBarcode } from "zxing-wasm/writer";
import { decodeQr } from "../api/domains/ocr/service/qr-input";
prepareZXingModule({
	overrides: {
		wasmBinary: await Bun.file(
			new URL(import.meta.resolve("zxing-wasm/writer/zxing_writer.wasm")),
		).arrayBuffer(),
	},
});
const qr = await writeBarcode("QR acceptance OCR-172", {
	format: "QRCode",
	scale: 8,
});
if (!qr.image) throw new Error("fixture_failed");
const image = await sharp({
	create: { width: 4000, height: 4000, channels: 3, background: "white" },
})
	.composite([
		{ input: Buffer.from(await qr.image.arrayBuffer()), left: 1200, top: 1600 },
	])
	.png()
	.toBuffer();
const start = performance.now();
const found = await decodeQr(image, null, AbortSignal.timeout(30_000));
if (found.length !== 1 || found[0]!.text !== "QR acceptance OCR-172")
	throw new Error("qr_benchmark_failed");
const result = {
	width: 4000,
	height: 4000,
	pixels: 16_000_000,
	inputBytes: image.length,
	durationMs: Math.round(performance.now() - start),
	parentRssBytes: process.memoryUsage().rss,
	qrCount: found.length,
};
mkdirSync("verification-reports/ocr-qr", { recursive: true });
writeFileSync(
	"verification-reports/ocr-qr/benchmark.json",
	JSON.stringify(result, null, 2),
);
console.log(JSON.stringify(result));
