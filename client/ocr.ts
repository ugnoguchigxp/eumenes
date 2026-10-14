import { z } from "zod";
import { ocrRecord } from "../api/domains/ocr/contracts";
import { json, type Transport } from "./transport";
export function ocrClient(t: Transport) {
	const root = "/api/ocr";
	const record = async (path: string, init?: RequestInit) =>
		ocrRecord.parse(await (await t.call(path, init)).json());
	return {
		ocrConnection: async (signal?: AbortSignal) =>
			z
				.object({
					revision: z.number(),
					serviceId: z.literal("ocr-host"),
					baseUrl: z.string().nullable(),
					credentialConfigured: z.boolean(),
				})
				.parse(await (await t.call("/api/settings/ocr", { signal })).json()),
		configureOcrConnection: async (input: {
			expectedRevision: number;
			baseUrl: string;
		}) =>
			(
				await t.call("/api/settings/ocr", { ...json(input), method: "PUT" })
			).json(),
		ocrRecords: async (conversationId: string, signal?: AbortSignal) =>
			ocrRecord
				.array()
				.parse(
					await (
						await t.call(
							`${root}?conversationId=${encodeURIComponent(conversationId)}`,
							{ signal },
						)
					).json(),
				),
		ocrUpload: async (
			file: File,
			conversationId: string,
			requestId: string,
		) => {
			const body = new FormData();
			body.append("file", file);
			return record(
				`${root}?conversationId=${encodeURIComponent(conversationId)}&requestId=${encodeURIComponent(requestId)}`,
				{ method: "POST", body },
			);
		},
		ocrGet: (id: string, signal?: AbortSignal) =>
			record(`${root}/${encodeURIComponent(id)}`, { signal }),
		ocrCancel: (id: string) =>
			record(`${root}/${encodeURIComponent(id)}/cancel`, json({})),
		ocrRecheck: (id: string) =>
			record(`${root}/${encodeURIComponent(id)}/recheck`, json({})),
		ocrRemove: async (id: string) => {
			await t.call(`${root}/${encodeURIComponent(id)}`, { method: "DELETE" });
		},
		ocrContent: async (id: string, signal?: AbortSignal) =>
			(
				await t.call(`${root}/${encodeURIComponent(id)}/content`, { signal })
			).blob(),
		ocrIncorporate: async (
			id: string,
			requestId: string,
			frameIndex?: number,
			lineIndexes?: number[],
		) =>
			(
				await t.call(
					`${root}/${encodeURIComponent(id)}/conversation`,
					json({ requestId, frameIndex, lineIndexes }),
				)
			).json(),
	};
}
