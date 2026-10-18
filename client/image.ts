import { imageRecord, imageImportView } from "../api/domains/image/contracts";
import {
	imageLibrary,
	imageArtifactDelete,
	imageArtifactId,
} from "../api/domains/larm/contracts";
import type { Transport } from "./transport";
export function imageClient(t: Transport) {
	return {
		importImage: async (
			requestId: string,
			file: File,
			signal?: AbortSignal,
		) => {
			const body = new FormData();
			body.append("file", file);
			return imageImportView.parse(
				await (
					await t.call(
						`/api/images/imports?requestId=${encodeURIComponent(requestId)}`,
						{ method: "POST", body, signal },
					)
				).json(),
			);
		},
		imageImport: async (requestId: string, signal?: AbortSignal) =>
			imageImportView.parse(
				await (
					await t.call(`/api/images/imports/${encodeURIComponent(requestId)}`, {
						signal,
					})
				).json(),
			),
		resumeImageImport: async (requestId: string, signal?: AbortSignal) =>
			imageImportView.parse(
				await (
					await t.call(
						`/api/images/imports/${encodeURIComponent(requestId)}/resume`,
						{ method: "POST", signal },
					)
				).json(),
			),
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
