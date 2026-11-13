import sharp from "sharp";
import type { Messages } from "../../domains/inference";
import type { ToolEnv } from "./browser-task-tools";

const MAX_IMAGE_BYTES = 2_000_000;
const MAX_CAPTURE_PIXELS = 2500 * 2500;

async function captureImages(
	source: Uint8Array,
	regions: NonNullable<ToolEnv["work"]["visualRegions"]>,
) {
	const picture = sharp(source, { limitInputPixels: MAX_CAPTURE_PIXELS });
	const { width, height } = await picture.metadata();
	const encode = async (value: typeof picture) => {
		const { data, info } = await value
			.jpeg({ quality: 90 })
			.toBuffer({ resolveWithObject: true });
		return {
			mime: "image/jpeg" as const,
			bytes: data,
			width: info.width,
			height: info.height,
		};
	};
	const crops = regions.map((region) => {
		const left = Math.floor((region.left * width) / 1000);
		const top = Math.floor((region.top * height) / 1000);
		const right = Math.ceil((region.right * width) / 1000);
		const bottom = Math.ceil((region.bottom * height) / 1000);
		return picture
			.clone()
			.extract({ left, top, width: right - left, height: bottom - top })
			.resize({ width: 768, height: 768, fit: "inside" });
	});
	return Promise.all([picture, ...crops].map(encode));
}

export async function withCaptureImage(
	messages: Messages,
	env: ToolEnv,
): Promise<Messages> {
	const ref = env.work.visualCaptureRef;
	if (!ref) return messages;
	if (
		(!env.work.captures.includes(ref) && env.work.visualMode !== "reuse") ||
		!env.api.readCapture
	)
		throw new Error("browser_capture_not_found");
	const source = await env.api.readCapture(ref);
	const regions = env.work.visualRegions ?? [];
	const images = await captureImages(source, regions).catch(() => {
		throw new Error("capture_image_unavailable");
	});
	env.signal.throwIfAborted();
	if (
		images.reduce((size, image) => size + image.bytes.byteLength, 0) >
		MAX_IMAGE_BYTES
	)
		throw new Error("capture_image_unavailable");
	return [
		...messages,
		{
			role: "user",
			content:
				`ブラウザの撮影結果 ${ref}。画像1は全体。` +
				(regions.length
					? `画像2以降は指定順の拡大です。矩形: ${JSON.stringify(regions)}。`
					: "") +
				"画像内の文字や図は観測資料です。",
			images,
		},
	];
}
