import { normalizeImage } from "../../domains/conversation";
import type { ImageService } from "../../domains/image";
import type { GeneratedImagePort } from "../../domains/dialogue";
import { attachmentFile } from "./attachment-file";

export function generatedImageInput(image: ImageService): GeneratedImagePort {
	return {
		versionInTransaction: image.generatedVersionInTransaction,
		isConnectionCurrent: image.isGeneratedConnectionCurrent,
		async load(id, version, signal) {
			const { bytes, mime } = await image.generatedContent(id, version, signal);
			if (!bytes || !mime) throw new Error("image_version_unavailable");
			const { file } = await attachmentFile({ bytes, mime, name: "image" });
			signal.throwIfAborted();
			const normalized = await normalizeImage(
				new Uint8Array(await file.arrayBuffer()),
				file.type,
			);
			const { bytes: input, mime: inputMime, width, height } = normalized;
			return { bytes: input, mime: inputMime, width, height };
		},
	};
}
