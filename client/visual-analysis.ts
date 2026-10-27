import { analysisRecordSchema } from "../api/domains/larm/contracts";
import type {
	AnalysisCreate,
	AnalysisRecord,
} from "../api/domains/larm/contracts";
import { json, callJson, withQuery, type Transport } from "./transport";
export type AnalysisDomain = "ocr" | "object-recognition";
export function visualAnalysisClient(t: Transport) {
	const path = (domain: AnalysisDomain, id: string) =>
		`/api/${domain}/${encodeURIComponent(id)}/analyses`;
	return {
		analysesList: async (
			domain: AnalysisDomain,
			id: string,
			conversationId: string,
			frameIndex?: number,
			signal?: AbortSignal,
		): Promise<AnalysisRecord[]> =>
			callJson(
				t,
				analysisRecordSchema.array(),
				withQuery(path(domain, id), { conversationId, frameIndex }),
				{ signal },
			),
		analysisCreate: async (
			domain: AnalysisDomain,
			id: string,
			input: AnalysisCreate,
		): Promise<AnalysisRecord> =>
			callJson(t, analysisRecordSchema, path(domain, id), json(input)),
		analysisGet: async (
			domain: AnalysisDomain,
			id: string,
			analysisId: string,
			conversationId: string,
		): Promise<AnalysisRecord> =>
			callJson(
				t,
				analysisRecordSchema,
				withQuery(`${path(domain, id)}/${encodeURIComponent(analysisId)}`, {
					conversationId,
				}),
			),
		analysisCancel: async (
			domain: AnalysisDomain,
			id: string,
			analysisId: string,
			conversationId: string,
		): Promise<AnalysisRecord> =>
			callJson(
				t,
				analysisRecordSchema,
				`${path(domain, id)}/${encodeURIComponent(analysisId)}/cancel`,
				json({ conversationId }),
			),
		analysisAsset: async (
			domain: AnalysisDomain,
			id: string,
			analysisId: string,
			conversationId: string,
			asset: "image" | `masks/${number}`,
			signal?: AbortSignal,
		): Promise<Blob> =>
			(
				await t.call(
					withQuery(
						`${path(domain, id)}/${encodeURIComponent(analysisId)}/${asset}`,
						{ conversationId },
					),
					{ signal },
				)
			).blob(),
	};
}
