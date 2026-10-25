import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";
import sharp from "sharp";
import { qrItems } from "../contracts/qr";

// This process owns synchronous WASM and image decoding so the host can kill it on cancellation.
if (import.meta.main) {
	try {
		prepareZXingModule({
			overrides: {
				wasmBinary: await Bun.file(
					new URL(import.meta.resolve("zxing-wasm/reader/zxing_reader.wasm")),
				).arrayBuffer(),
			},
		});
		const input = new Uint8Array(await Bun.stdin.arrayBuffer());
		const { data, info } = await sharp(input, {
			limitInputPixels: 64_000_000,
			failOn: "error",
		})
			.ensureAlpha()
			.raw()
			.toBuffer({ resolveWithObject: true });
		const found = await readBarcodes(
			{
				data: new Uint8ClampedArray(data),
				width: info.width,
				height: info.height,
				colorSpace: "srgb",
			},
			{
				formats: ["QRCode"],
				textMode: "Plain",
				tryHarder: true,
				maxNumberOfSymbols: 255,
			},
		);
		const items = qrItems.parse(
			found.map((r) => ({
				text: r.contentType === "Text" ? r.text : null,
				contentType: r.contentType,
				polygon: [
					r.position.topLeft,
					r.position.topRight,
					r.position.bottomRight,
					r.position.bottomLeft,
				].map((p) => [p.x, p.y]),
			})),
		);
		process.stdout.write(JSON.stringify(items));
	} catch {
		process.exitCode = 1;
	}
}
