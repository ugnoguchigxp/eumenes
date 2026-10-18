import { z } from "zod";
import {
	handoff,
	recognitionRecord,
} from "../api/domains/object-recognition/contracts";
import { runSchema } from "../api/domains/dialogue/contracts";
import { attachmentSchema } from "../api/domains/conversation/contracts";
import { callJson, json, type Transport } from "./transport";

const recognitionConnectionSchema = z.object({
	revision: z.number(),
	serviceId: z.literal("object-recognition-host"),
	baseUrl: z.string().nullable(),
	credentialConfigured: z.boolean(),
	credentialSource: z.enum(["dedicated", "larm"]).default("dedicated"),
	sharedCredentialAvailable: z.boolean().default(false),
});
export function objectRecognitionClient(t: Transport) {
	const root = "/api/object-recognition";
	const record = async (path: string, init?: RequestInit) =>
		recognitionRecord.parse(await (await t.call(path, init)).json());
	return {
		recognitionConnection: (signal?: AbortSignal) =>
			callJson(
				t,
				recognitionConnectionSchema,
				"/api/settings/object-recognition",
				{
					signal,
				},
			),
		configureRecognitionConnection: async (input: {
			expectedRevision: number;
			credentialSource: "dedicated" | "larm";
			baseUrl?: string;
		}) =>
			callJson(
				t,
				recognitionConnectionSchema,
				"/api/settings/object-recognition",
				{
					...json(input),
					method: "PUT",
				},
			),
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
			origin: "camera" | "screen" | "file" = "file",
		) => {
			const body = new FormData();
			body.append("file", file);
			return record(
				`${root}?conversationId=${encodeURIComponent(conversationId)}&requestId=${encodeURIComponent(requestId)}&origin=${origin}`,
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
		/** A pending chat attachment (the still and its detections); the user sends it. */
		recognitionAttach: (id: string, requestId: string) =>
			callJson(
				t,
				attachmentSchema,
				`${root}/${encodeURIComponent(id)}/attachment`,
				json({ requestId }),
			),
		recognitionHandoffs: (conversationId: string, signal?: AbortSignal) =>
			callJson(
				t,
				handoff.array(),
				`${root}/handoffs?conversationId=${encodeURIComponent(conversationId)}`,
				{ signal },
			),
		recognitionHandoffSend: (id: string, recognitionId?: string) =>
			callJson(
				t,
				runSchema,
				`${root}/handoffs/${encodeURIComponent(id)}/send`,
				json(recognitionId ? { recognitionId } : {}),
			),
		recognitionHandoffCancel: (id: string) =>
			callJson(
				t,
				handoff,
				`${root}/handoffs/${encodeURIComponent(id)}/cancel`,
				json({}),
			),
	};
}
