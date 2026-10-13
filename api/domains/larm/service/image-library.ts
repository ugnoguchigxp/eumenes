import {
	imageArtifact,
	imageArtifactId,
	imageArtifactDelete,
	imageLibrary,
} from "../contracts/image-library";
import { json } from "./playground-http";
export function createImageLibrary(
	control: (
		path: string,
		signal: AbortSignal,
		init?: RequestInit,
	) => Promise<Response>,
	publicUrl: (path: string) => URL,
) {
	function validate(a: ReturnType<typeof imageArtifact.parse>) {
		if (
			publicUrl(a.contentUrl).pathname !==
				`/v1/image-artifacts/${encodeURIComponent(a.id)}/content` ||
			a.mimeType !== `image/${a.format}`
		)
			throw new Error("invalid_image_artifact");
		return a;
	}
	return {
		async remove(id: string, signal: AbortSignal) {
			imageArtifactId.parse(id);
			const result = imageArtifactDelete.parse(
				await json(
					await control(
						`/v1/image-artifacts/${encodeURIComponent(id)}`,
						signal,
						{ method: "DELETE" },
					),
				),
			);
			if (result.id !== id) throw new Error("invalid_image_delete_result");
			return result;
		},
		async list(signal: AbortSignal) {
			const result = imageLibrary.parse(
				await json(await control("/v1/image-artifacts", signal)),
			);
			return { ...result, images: result.images.map(validate) };
		},
		async get(id: string, signal: AbortSignal) {
			imageArtifactId.parse(id);
			return validate(
				imageArtifact.parse(
					await json(
						await control(
							`/v1/image-artifacts/${encodeURIComponent(id)}`,
							signal,
						),
					),
				),
			);
		},
	};
}
