import sharp, { type OutputInfo } from "sharp";
import type { ImageMaterial } from "../../domains/object-recognition";
import { attachmentLimits } from "../../domains/conversation/contracts";

/**
 * WebP or over-limit images become a JPEG the attachment rules accept; others pass unchanged.
 * `scaled` is the attached size when it differs from the source (detection boxes stay in source pixels).
 */
export async function attachmentFile(
	m: Pick<ImageMaterial, "bytes" | "mime" | "name">,
): Promise<{ file: File; scaled?: { width: number; height: number } }> {
	const meta = await sharp(m.bytes).metadata();
	const pixels = (meta.width ?? 0) * (meta.height ?? 0);
	if (
		(m.mime === "image/jpeg" || m.mime === "image/png") &&
		m.bytes.length <= attachmentLimits.maxBytes &&
		pixels <= attachmentLimits.maxPixels &&
		Math.max(meta.width ?? 0, meta.height ?? 0) <= attachmentLimits.maxDimension
	)
		return {
			file: new File([new Uint8Array(m.bytes)], m.name, { type: m.mime }),
		};
	let out: { data: Buffer; info: OutputInfo } | undefined;
	for (const edge of [4096, 2560, 1600]) {
		out = await sharp(m.bytes)
			.rotate()
			.resize({
				width: edge,
				height: edge,
				fit: "inside",
				withoutEnlargement: true,
			})
			.flatten({ background: "#ffffff" })
			.jpeg({ quality: 88 })
			.toBuffer({ resolveWithObject: true });
		if (out.data.length <= attachmentLimits.maxBytes) break;
	}
	const file = new File(
		[new Uint8Array(out!.data)],
		m.name.replace(/\.\w+$/, "") + ".jpg",
		{ type: "image/jpeg" },
	);
	return out!.info.width === meta.width && out!.info.height === meta.height
		? { file }
		: { file, scaled: { width: out!.info.width, height: out!.info.height } };
}
