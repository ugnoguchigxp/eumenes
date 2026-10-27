import { z } from "zod";
import { variableNamePattern } from "./history";

const variable = z.strictObject({
	name: z.string().regex(variableNamePattern),
	label: z.string().trim().min(1).max(40),
	value: z.string().trim().min(1).max(200),
});

/** The Script as the page operator publishes it (spec browser-run-history §6.3). */
export const scriptPublish = z
	.strictObject({
		expectedRevision: z.number().int().min(0),
		title: z.string().trim().min(1).max(60),
		summary: z.string().trim().min(1).max(300),
		historyId: z.uuid().optional(),
		variables: z.array(variable).max(5).optional(),
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
	})
	.refine(
		(s) =>
			new Set(s.variables?.map((v) => v.name)).size ===
			(s.variables?.length ?? 0),
		"variable_name_duplicate",
	);
export type ScriptPublish = z.infer<typeof scriptPublish>;
export type ScriptVariable = z.infer<typeof variable>;
export type ScriptStep = ScriptPublish["steps"][number] & { stepId: string };
export type ScriptRevision = {
	revision: number;
	/** Absent in Scripts stored before histories existed. */
	title?: string;
	summary: string;
	historyId?: string;
	variables?: ScriptVariable[];
	steps: ScriptStep[];
	change?: string;
	updatedAt: number;
};
export type ScriptView = ScriptRevision & { history: ScriptRevision[] };
export type ScriptBinding = { revision: number; stepId: string };
