import sharp from "sharp";
import * as bmp from "bmp-ts";
import type { ChatImage } from "../contracts";

/** Normalized 24-bit BMP and decoded JPEG/PNG stand-ins, without another domain's implementation. */
export async function inputImages(): Promise<ChatImage[]> {
	const width = 24,
		height = 18;
	const data = {
		create: { width, height, channels: 3 as const, background: "#e02020" },
	};
	return [
		{
			mime: "image/jpeg",
			bytes: await sharp(data).jpeg().toBuffer(),
			width,
			height,
		},
		{
			mime: "image/png",
			bytes: await sharp(data).png().toBuffer(),
			width,
			height,
		},
		{
			mime: "image/bmp",
			bytes: bmp.encode({
				data: Buffer.from(
					Array.from({ length: width * height }, () => [
						255, 32, 32, 224,
					]).flat(),
				),
				width,
				height,
				bitPP: 24,
			}).data,
			width,
			height,
		},
	];
}
