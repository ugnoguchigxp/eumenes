import { z } from "zod";

export const scriptPublish = z.strictObject({
	expectedRevision: z.number().int().min(0),
	summary: z.string().trim().min(1).max(300),
	steps: z
		.array(
			z.strictObject({
				stepId: z.uuid().optional(),
				label: z.string().trim().min(1).max(160),
				expectation: z.string().trim().min(1).max(200),
				state: z.enum(["pending", "running", "completed", "skipped"]),
				evidenceRef: z.uuid().optional(),
			}),
		)
		.min(1)
		.max(12),
	change: z.string().trim().max(200).optional(),
});
export type ScriptPublish = z.infer<typeof scriptPublish>;
export type ScriptStep = ScriptPublish["steps"][number] & { stepId: string };
export type ScriptRevision = {
	revision: number;
	summary: string;
	steps: ScriptStep[];
	change?: string;
	updatedAt: number;
};
export type ScriptView = ScriptRevision & { history: ScriptRevision[] };
export type ScriptBinding = { revision: number; stepId: string };
