import { z } from "zod";
import { correctionRecord, ocrRecord } from "../api/domains/ocr/contracts";
import { runSchema } from "../api/domains/dialogue/contracts";
import { callJson, json, type Transport } from "./transport";

const ocrConnectionSchema = z.object({
	revision: z.number(),
	serviceId: z.literal("ocr-host"),
	baseUrl: z.string().nullable(),
	credentialConfigured: z.boolean(),
});
export function ocrClient(t: Transport) {
	const root = "/api/ocr";
	const record = async (path: string, init?: RequestInit) =>
		ocrRecord.parse(await (await t.call(path, init)).json());
	return {
		ocrConnection: (signal?: AbortSignal) =>
			callJson(t, ocrConnectionSchema, "/api/settings/ocr", { signal }),
		configureOcrConnection: async (input: {
			expectedRevision: number;
			baseUrl: string;
		}) =>
			callJson(t, ocrConnectionSchema, "/api/settings/ocr", {
				...json(input),
				method: "PUT",
			}),
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
			callJson(
				t,
				runSchema,
				`${root}/${encodeURIComponent(id)}/conversation`,
				json({ requestId, frameIndex, lineIndexes }),
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
			correctionRecord.parse(
				await (
					await t.call(
						`${root}/${encodeURIComponent(id)}/corrections`,
						json(input),
					)
				).json(),
			),
		ocrCorrections: async (
			id: string,
			conversationId: string,
			frameIndex?: number,
			before?: number,
			signal?: AbortSignal,
		) =>
			z
				.object({
					items: correctionRecord.array(),
					nextCursor: z.number().nullable(),
					preference: z.object({
						preferredId: z.string().nullable(),
						revision: z.number(),
					}),
				})
				.parse(
					await (
						await t.call(
							`${root}/${encodeURIComponent(id)}/corrections?${new URLSearchParams({ conversationId, ...(frameIndex === undefined ? {} : { frameIndex: String(frameIndex) }), ...(before === undefined ? {} : { before: String(before) }) })}`,
							{ signal },
						)
					).json(),
				),
		ocrCorrectionGet: async (
			id: string,
			candidateId: string,
			conversationId: string,
		) =>
			correctionRecord.parse(
				await (
					await t.call(
						`${root}/${encodeURIComponent(id)}/corrections/${encodeURIComponent(candidateId)}?conversationId=${encodeURIComponent(conversationId)}`,
					)
				).json(),
			),
		ocrCorrectionCancel: async (
			id: string,
			candidateId: string,
			conversationId: string,
		) =>
			correctionRecord.parse(
				await (
					await t.call(
						`${root}/${encodeURIComponent(id)}/corrections/${encodeURIComponent(candidateId)}/cancel`,
						json({ conversationId }),
					)
				).json(),
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
			z
				.object({ preferredId: z.string().nullable(), revision: z.number() })
				.parse(
					await (
						await t.call(
							`${root}/${encodeURIComponent(id)}/corrections/preference`,
							{ ...json(input), method: "PUT" },
						)
					).json(),
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
