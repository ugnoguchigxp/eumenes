import { imageRecord, imageImportView } from "../api/domains/image/contracts";
import {
	imageLibrary,
	imageArtifactDelete,
	imageArtifactId,
} from "../api/domains/larm/contracts";
import { callJson, withQuery, type Transport } from "./transport";
export function imageClient(t: Transport) {
	return {
		importImage: async (
			requestId: string,
			file: File,
			signal?: AbortSignal,
		) => {
			const body = new FormData();
			body.append("file", file);
			return callJson(
				t,
				imageImportView,
				withQuery("/api/images/imports", { requestId }),
				{ method: "POST", body, signal },
			);
		},
		imageImport: async (requestId: string, signal?: AbortSignal) =>
			callJson(
				t,
				imageImportView,
				`/api/images/imports/${encodeURIComponent(requestId)}`,
				{ signal },
			),
		resumeImageImport: async (requestId: string, signal?: AbortSignal) =>
			callJson(
				t,
				imageImportView,
				`/api/images/imports/${encodeURIComponent(requestId)}/resume`,
				{ method: "POST", signal },
			),
		deleteImage: async (id: string, signal?: AbortSignal) => {
			imageArtifactId.parse(id);
			const result = await callJson(
				t,
				imageArtifactDelete,
				`/api/images/${encodeURIComponent(id)}`,
				{ method: "DELETE", signal },
			);
			if (result.id !== id) throw new Error("invalid_image_delete_result");
			return result;
		},
		imageGenerations: async (conversationId: string, signal?: AbortSignal) =>
			callJson(
				t,
				imageRecord.array(),
				withQuery("/api/images/generations", { conversationId }),
				{ signal },
			),
		imageLibrary: async (signal?: AbortSignal) =>
			callJson(t, imageLibrary, "/api/images/library", { signal }),
		imageContent: async (id: string, signal?: AbortSignal) =>
			(
				await t.call(`/api/images/${encodeURIComponent(id)}/content`, {
					signal,
				})
			).blob(),
	};
}
