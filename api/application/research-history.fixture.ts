import { expect } from "bun:test";
import { harness, workerPacket } from "./toolchain.fixture";
import type { Messages } from "../domains/inference/contracts";
import type { AcquisitionPort } from "../domains/web-research";
export type ReplayData = {
	task: { question: string };
	observations: Array<{
		document: string;
		sourceId?: string;
		viewId?: string;
		sourceRef?: string;
		messageRef?: string;
		basis: string;
		url?: string;
		speaker?: string;
		createdAt?: string;
		excerpts: Array<{ reference: string; excerptId?: string; quote: string }>;
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
		fullResearch: true,
		...options,
		async control(messages) {
			const system = messages[0]!.content;
			const data = workerPacket(messages);
			if (system.includes("TOOLS=")) {
				const step = steps[position++];
				if (!step) throw new Error("replay_extra_model_call");
				inputs.push(data);
				const result = (await step(data, messages)) as object;
				return JSON.stringify(result);
			}
			throw new Error("replay_unexpected_control_call");
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
	return { action: "invoke", tool, arguments: args };
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
	const excerpt = source.excerpts.find((e) => e.quote.includes(keyword))!;
	return {
		action: "finish",
		report: {
			outcome,
			summary: keyword,
			claims: [
				{
					text: keyword,
					evidence: [excerpt.reference],
				},
			],
			limitations: [],
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
