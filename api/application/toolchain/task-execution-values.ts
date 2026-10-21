import { z } from "zod";
import type { ChildExecution, ChildResult } from "../../domains/tool-runtime";
export const reference = z.looseObject({
	kind: z.enum([
		"research",
		"bound",
		"instant",
		"question",
		"media",
		"legacy",
		"session",
	]),
	dispatchId: z.string().optional(),
	operationId: z.string().optional(),
	adapterRef: z.string().optional(),
	calls: z.number().optional(),
	reportDigest: z.string().nullable().optional(),
	answerSchema: z.string().optional(),
});
export const result = (
	state: ChildResult["state"],
	ref: unknown,
	summary: string,
	modelCalls = 0,
	code?: string,
): ChildResult => ({
	state,
	ref,
	summary: summary.slice(0, 2000),
	modelCalls,
	references: [],
	...(code ? { code } : {}),
});
export const total = (child: ChildExecution, calls: number) =>
	(child.usedModelCalls ?? 0) + calls;
