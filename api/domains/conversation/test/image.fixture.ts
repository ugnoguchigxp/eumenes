import sharp from "sharp";
import * as bmp from "bmp-ts";
export async function syntheticImages() {
	const data = {
		create: {
			width: 24,
			height: 18,
			channels: 3 as const,
			background: "#e02020",
		},
	};
	return [
		new File([await sharp(data).jpeg().toBuffer()], "red.jpg", {
			type: "image/jpeg",
		}),
		new File([await sharp(data).png().toBuffer()], "red.png", {
			type: "image/png",
		}),
		new File(
			[
				new Uint8Array(
					bmp.encode({
						data: Buffer.from(
							Array.from({ length: 24 * 18 }, () => [255, 32, 32, 224]).flat(),
						),
						width: 24,
						height: 18,
						bitPP: 24,
					}).data,
				),
			],
			"red.bmp",
			{ type: "image/bmp" },
		),
	];
}
