import { z } from "zod";
import { recognitionRecord } from "../api/domains/object-recognition/contracts";
import { json, type Transport } from "./transport";
export function objectRecognitionClient(t: Transport) {
	const root = "/api/object-recognition";
	const record = async (path: string, init?: RequestInit) =>
		recognitionRecord.parse(await (await t.call(path, init)).json());
	return {
		recognitionConnection: async (signal?: AbortSignal) =>
			z
				.object({
					revision: z.number(),
					serviceId: z.literal("object-recognition-host"),
					baseUrl: z.string().nullable(),
					credentialConfigured: z.boolean(),
					credentialSource: z.enum(["dedicated", "larm"]).default("dedicated"),
					sharedCredentialAvailable: z.boolean().default(false),
				})
				.parse(
					await (
						await t.call("/api/settings/object-recognition", { signal })
					).json(),
				),
		configureRecognitionConnection: async (input: {
			expectedRevision: number;
			credentialSource: "dedicated" | "larm";
			baseUrl?: string;
		}) => {
			const response = await t.call("/api/settings/object-recognition", {
				...json(input),
				method: "PUT",
			});
			return response.json();
		},
		recognitionRecords: async (conversationId: string, signal?: AbortSignal) =>
			recognitionRecord
				.array()
				.parse(
					await (
						await t.call(
							`${root}?conversationId=${encodeURIComponent(conversationId)}`,
							{ signal },
						)
					).json(),
				),
		recognitionCommands: async (conversationId: string, signal?: AbortSignal) =>
			z
				.string()
				.array()
				.parse(
					await (
						await t.call(
							`${root}/commands?conversationId=${encodeURIComponent(conversationId)}`,
							{ signal },
						)
					).json(),
				),
		recognitionUpload: async (
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
		recognitionGet: (id: string, signal?: AbortSignal) =>
			record(`${root}/${encodeURIComponent(id)}`, { signal }),
		recognitionCancel: (id: string) =>
			record(`${root}/${encodeURIComponent(id)}/cancel`, json({})),
		recognitionRecheck: (id: string) =>
			record(`${root}/${encodeURIComponent(id)}/recheck`, json({})),
		recognitionRemove: async (id: string) => {
			await t.call(`${root}/${encodeURIComponent(id)}`, { method: "DELETE" });
		},
		recognitionContent: async (id: string, signal?: AbortSignal) =>
			(
				await t.call(`${root}/${encodeURIComponent(id)}/content`, { signal })
			).blob(),
		recognitionIncorporate: async (
			id: string,
			requestId: string,
			frameIndex?: number,
		) =>
			(
				await t.call(
					`${root}/${encodeURIComponent(id)}/conversation`,
					json({ requestId, frameIndex }),
				)
			).json(),
	};
}
