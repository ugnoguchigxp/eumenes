import { fileURLToPath } from "node:url";
import { readBounded } from "../../../infrastructure/bounded-read";
import { qrItems, type QrItem } from "../contracts/qr";
import { imageForInput } from "./correction-shared";

export const qrDecoderVersion = "zxing-wasm@3.1.5";
export async function decodeQr(
	bytes: Uint8Array,
	timestamp: number | null,
	signal: AbortSignal,
	dimensions?: { width: number; height: number },
): Promise<QrItem[]> {
	const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
	const image = await imageForInput(
		bytes,
		timestamp,
		boundedSignal,
		["image/png"],
		64 * 1024 * 1024,
	);
	if (
		dimensions &&
		(dimensions.width !== image.width || dimensions.height !== image.height)
	)
		throw new Error("ocr_qr_dimensions_changed");
	boundedSignal.throwIfAborted();
	const proc = Bun.spawn(
		[
			process.execPath,
			fileURLToPath(new URL("./qr-decode.ts", import.meta.url)),
		],
		{
			stdin: image.bytes,
			stdout: "pipe",
			stderr: "ignore",
			signal: boundedSignal,
		},
	);
	try {
		const output = await readBounded(proc.stdout, {
			limit: 2 * 1024 * 1024,
			missing: "ocr_qr_failed",
			tooLarge: "ocr_qr_too_large",
			signal: boundedSignal,
		});
		if ((await proc.exited) !== 0) throw new Error("ocr_qr_failed");
		boundedSignal.throwIfAborted();
		const items = qrItems.parse(JSON.parse(new TextDecoder().decode(output)));
		if (
			items.some((i) =>
				i.polygon.some(([x, y]) => x > image.width || y > image.height),
			)
		)
			throw new Error("ocr_qr_invalid_position");
		return items;
	} finally {
		proc.kill();
	}
}
