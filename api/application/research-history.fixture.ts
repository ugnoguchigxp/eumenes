import { expect } from "bun:test";
import { harness } from "./toolchain.fixture";
import type { Messages } from "../domains/inference/contracts";
import type { AcquisitionPort } from "../domains/web-research";
export type ReplayData = {
	task: { question: string };
	observations: Array<{
		sourceId: string;
		viewId: string;
		sourceRef?: string;
		messageRef?: string;
		basis: string;
		url?: string;
		speaker?: string;
		createdAt?: string;
		excerpts: Array<{ excerptId: string; quote: string }>;
	}>;
	operations: Array<{
		notes?: {
			matches?: Array<{ cursor: string }>;
			scope?: { scanComplete: boolean };
			cursor?: string;
		};
	}>;
};
export type ReplayStep = (data: ReplayData, messages: Messages) => unknown;
/** Synthetic responses only: overrun and unconsumed steps are errors, never default model output. */
export async function replay(
	steps: ReplayStep[],
	options: {
		history?: boolean;
		urls?: string[];
		acquire?: AcquisitionPort["execute"];
		parent?: (messages: Messages) => string | Promise<string>;
	} = {},
) {
	let position = 0;
	const inputs: ReplayData[] = [];
	const h = await harness({
		...options,
		async control(messages) {
			const system = messages[0]!.content;
			const data = JSON.parse(messages.find((m) => m.role === "user")!.content);
			if (system.includes("TOOLS=")) {
				const step = steps[position++];
				if (!step) throw new Error("replay_extra_model_call");
				inputs.push(data);
				const result = (await step(data, messages)) as object;
				return JSON.stringify({
					needs: [
						{
							id: "answer",
							item: data.task.question.slice(0, 200),
							requestQuote: data.task.question.slice(0, 300),
							status: "missing",
						},
					],
					...result,
				});
			}
			if (data.candidates) {
				const c = data.candidates.find(
					(c: { id: string }) =>
						c.id === (options.history ? "history.research" : "web.research"),
				);
				if (!c) throw new Error("replay_candidate_missing");
				return JSON.stringify({
					action: "select",
					candidateRef: c.candidateRef,
					input: {
						question: data.task.question,
						detail: "normal",
						...(options.urls ? { urls: options.urls } : {}),
					},
				});
			}
			return JSON.stringify({
				action: "discover",
				intent: options.history ? "会話履歴の確認" : "公開資料の調査",
				terms: [options.history ? "history" : "web.research"],
			});
		},
	});
	return Object.assign(h, {
		inputs,
		assertConsumed() {
			expect(position).toBe(steps.length);
		},
	});
}
export function invoke(tool: string, args: unknown) {
	return { action: "invoke", executionRef: tool, arguments: args };
}
export function finish(
	data: ReplayData,
	keyword: string,
	outcome = "answered",
) {
	const source = data.observations.find((s) =>
		s.excerpts.some((e) => e.quote.includes(keyword)),
	);
	if (!source) throw new Error("replay_expected_evidence_missing");
	return {
		action: "finish",
		report: {
			version: 2,
			outcome,
			summary: keyword,
			claims: [
				{
					text: keyword,
					evidence: [
						{
							sourceId: source.sourceId,
							viewId: source.viewId,
							excerptId: source.excerpts.find((e) => e.quote.includes(keyword))!
								.excerptId,
						},
					],
				},
			],
			limitations: [],
			exploration: ["合成入力の許可範囲"],
		},
	};
}
export const syntheticAcquisition =
	(texts: Record<string, string>): AcquisitionPort["execute"] =>
	async (request) => {
		const observedAt = new Date().toISOString();
		const docs =
			request.operation === "read"
				? [
						{
							url: request.url,
							title: "合成資料",
							text: texts[request.url] ?? "対象外の資料",
							fetchedAt: observedAt,
							acquisitionTruncated: false,
						},
					]
				: [];
		return {
			freshUntilMs: null,
			bodies: docs,
			result: {
				provider: "llm-fetch@0.1.2",
				observedAt,
				cache: "bypass",
				hits:
					request.operation === "lookup"
						? Object.keys(texts)
								.slice(0, 5)
								.map((url) => ({
									url,
									title: "合成候補",
									snippet: "本文を確認",
									provider: "fixture",
									trust: "untrusted",
									tainted: true,
									verification: "search_summary",
								}))
						: [],
				documents: docs.map((d) => ({
					...d,
					text: d.text.slice(0, 12000),
					truncated: d.text.length > 12000,
					trust: "untrusted",
					tainted: true,
					verification: "source_read",
					guardDecision: "allow",
					guardReasonCodes: [],
				})),
				failures: [],
			},
		};
	};
