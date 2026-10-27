import { z } from "zod";
import {
	correctionRecord,
	ocrRecord,
	qrRecord,
} from "../api/domains/ocr/contracts";
import { runSchema } from "../api/domains/dialogue/contracts";
import { callJson, json, withQuery, type Transport } from "./transport";

const ocrConnectionSchema = z.object({
	revision: z.number(),
	serviceId: z.literal("ocr-host"),
	baseUrl: z.string().nullable(),
	credentialConfigured: z.boolean(),
	sharedCredentialAvailable: z.boolean().optional(),
});
export function ocrClient(t: Transport) {
	const root = "/api/ocr";
	return {
		ocrConnection: (signal?: AbortSignal) =>
			callJson(t, ocrConnectionSchema, "/api/settings/ocr", { signal }),
		configureOcrConnection: async (input: {
			expectedRevision: number;
			baseUrl: string;
		}) =>
			callJson(t, ocrConnectionSchema, "/api/settings/ocr", json(input, "PUT")),
		ocrRecords: async (conversationId: string, signal?: AbortSignal) =>
			callJson(t, ocrRecord.array(), withQuery(root, { conversationId }), {
				signal,
			}),
		ocrUpload: async (
			file: File,
			conversationId: string,
			requestId: string,
		) => {
			const body = new FormData();
			body.append("file", file);
			return callJson(
				t,
				ocrRecord,
				withQuery(root, { conversationId, requestId }),
				{ method: "POST", body },
			);
		},
		ocrGet: (id: string, signal?: AbortSignal) =>
			callJson(t, ocrRecord, `${root}/${encodeURIComponent(id)}`, { signal }),
		ocrCancel: (id: string) =>
			callJson(
				t,
				ocrRecord,
				`${root}/${encodeURIComponent(id)}/cancel`,
				json({}),
			),
		ocrRecheck: (id: string) =>
			callJson(
				t,
				ocrRecord,
				`${root}/${encodeURIComponent(id)}/recheck`,
				json({}),
			),
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
			callJson(
				t,
				runSchema,
				`${root}/${encodeURIComponent(id)}/conversation`,
				json({ requestId, frameIndex, lineIndexes }),
			),
		ocrQr: async (
			id: string,
			conversationId: string,
			frameIndex?: number,
			signal?: AbortSignal,
		) =>
			callJson(
				t,
				qrRecord.nullable(),
				withQuery(`${root}/${encodeURIComponent(id)}/qr`, {
					conversationId,
					frameIndex,
				}),
				{ signal },
			),
		ocrQrCreate: async (
			id: string,
			input: {
				requestId: string;
				conversationId: string;
				expectedRevision: number;
				frameIndex?: number;
			},
		) =>
			callJson(
				t,
				qrRecord,
				`${root}/${encodeURIComponent(id)}/qr`,
				json(input),
			),
		ocrQrGet: async (id: string, qrId: string, conversationId: string) =>
			callJson(
				t,
				qrRecord,
				withQuery(
					`${root}/${encodeURIComponent(id)}/qr/${encodeURIComponent(qrId)}`,
					{ conversationId },
				),
			),
		ocrQrCancel: async (id: string, qrId: string, conversationId: string) =>
			callJson(
				t,
				qrRecord,
				`${root}/${encodeURIComponent(id)}/qr/${encodeURIComponent(qrId)}/cancel`,
				json({ conversationId }),
			),
		ocrQrIncorporate: async (
			id: string,
			qrId: string,
			conversationId: string,
			index: number,
			requestId: string,
		) =>
			callJson(
				t,
				runSchema,
				`${root}/${encodeURIComponent(id)}/qr/${encodeURIComponent(qrId)}/conversation`,
				json({ conversationId, index, requestId }),
			),
		ocrCorrectionCreate: async (
			id: string,
			input: {
				requestId: string;
				conversationId: string;
				expectedRevision: number;
				frameIndex?: number;
			},
		) =>
			callJson(
				t,
				correctionRecord,
				`${root}/${encodeURIComponent(id)}/corrections`,
				json(input),
			),
		ocrCorrections: async (
			id: string,
			conversationId: string,
			frameIndex?: number,
			before?: number,
			signal?: AbortSignal,
		) =>
			callJson(
				t,
				z.object({
					items: correctionRecord.array(),
					nextCursor: z.number().nullable(),
					preference: z.object({
						preferredId: z.string().nullable(),
						revision: z.number(),
					}),
				}),
				withQuery(`${root}/${encodeURIComponent(id)}/corrections`, {
					conversationId,
					frameIndex,
					before,
				}),
				{ signal },
			),
		ocrCorrectionGet: async (
			id: string,
			candidateId: string,
			conversationId: string,
		) =>
			callJson(
				t,
				correctionRecord,
				withQuery(
					`${root}/${encodeURIComponent(id)}/corrections/${encodeURIComponent(candidateId)}`,
					{ conversationId },
				),
			),
		ocrCorrectionCancel: async (
			id: string,
			candidateId: string,
			conversationId: string,
		) =>
			callJson(
				t,
				correctionRecord,
				`${root}/${encodeURIComponent(id)}/corrections/${encodeURIComponent(candidateId)}/cancel`,
				json({ conversationId }),
			),
		ocrCorrectionPrefer: async (
			id: string,
			input: {
				conversationId: string;
				frameIndex?: number;
				preferredId: string | null;
				expectedRevision: number;
			},
		) =>
			callJson(
				t,
				z.object({ preferredId: z.string().nullable(), revision: z.number() }),
				`${root}/${encodeURIComponent(id)}/corrections/preference`,
				json(input, "PUT"),
			),
		ocrCorrectionIncorporate: async (
			id: string,
			candidateId: string,
			requestId: string,
			conversationId: string,
		) =>
			callJson(
				t,
				runSchema,
				`${root}/${encodeURIComponent(id)}/corrections/${encodeURIComponent(candidateId)}/conversation`,
				json({ requestId, conversationId }),
			),
	};
}
