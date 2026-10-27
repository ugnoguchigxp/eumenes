import { z } from "zod";
import {
	handoff,
	recognitionRecord,
} from "../api/domains/object-recognition/contracts";
import { runSchema } from "../api/domains/dialogue/contracts";
import { attachmentSchema } from "../api/domains/conversation/contracts";
import { callJson, json, withQuery, type Transport } from "./transport";

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
				json(input, "PUT"),
			),
		recognitionRecords: async (conversationId: string, signal?: AbortSignal) =>
			callJson(
				t,
				recognitionRecord.array(),
				withQuery(root, { conversationId }),
				{ signal },
			),
		recognitionCommands: async (conversationId: string, signal?: AbortSignal) =>
			callJson(
				t,
				z.string().array(),
				withQuery(`${root}/commands`, { conversationId }),
				{ signal },
			),
		recognitionUpload: async (
			file: File,
			conversationId: string,
			requestId: string,
			origin: "camera" | "screen" | "file" = "file",
			handoffId?: string,
		) => {
			const body = new FormData();
			body.append("file", file);
			return callJson(
				t,
				recognitionRecord,
				withQuery(root, {
					conversationId,
					requestId,
					origin,
					handoffId: handoffId || undefined,
				}),
				{ method: "POST", body },
			);
		},
		recognitionGet: (id: string, signal?: AbortSignal) =>
			callJson(t, recognitionRecord, `${root}/${encodeURIComponent(id)}`, {
				signal,
			}),
		recognitionCancel: (id: string) =>
			callJson(
				t,
				recognitionRecord,
				`${root}/${encodeURIComponent(id)}/cancel`,
				json({}),
			),
		recognitionRecheck: (id: string) =>
			callJson(
				t,
				recognitionRecord,
				`${root}/${encodeURIComponent(id)}/recheck`,
				json({}),
			),
		recognitionResumeCaptureSave: (id: string) =>
			callJson(
				t,
				recognitionRecord,
				`${root}/${encodeURIComponent(id)}/capture-save-resume`,
				json({}),
			),
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
				withQuery(`${root}/handoffs`, { conversationId }),
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
