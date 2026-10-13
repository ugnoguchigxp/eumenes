import { imageRecord } from "../api/domains/image/contracts";
import {
	imageLibrary,
	imageArtifactDelete,
	imageArtifactId,
} from "../api/domains/larm/contracts";
import type { Transport } from "./transport";
export function imageClient(t: Transport) {
	return {
		deleteImage: async (id: string, signal?: AbortSignal) => {
			imageArtifactId.parse(id);
			const result = imageArtifactDelete.parse(
				await (
					await t.call(`/api/images/${encodeURIComponent(id)}`, {
						method: "DELETE",
						signal,
					})
				).json(),
			);
			if (result.id !== id) throw new Error("invalid_image_delete_result");
			return result;
		},
		imageGenerations: async (conversationId: string, signal?: AbortSignal) =>
			imageRecord
				.array()
				.parse(
					await (
						await t.call(
							`/api/images/generations?conversationId=${encodeURIComponent(conversationId)}`,
							{ signal },
						)
					).json(),
				),
		imageLibrary: async (signal?: AbortSignal) =>
			imageLibrary.parse(
				await (await t.call("/api/images/library", { signal })).json(),
			),
		imageContent: async (id: string, signal?: AbortSignal) =>
			(
				await t.call(`/api/images/${encodeURIComponent(id)}/content`, {
					signal,
				})
			).blob(),
	};
}
