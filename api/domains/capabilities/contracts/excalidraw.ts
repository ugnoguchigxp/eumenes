import { z } from "zod";
export const drawingRequest = z.strictObject({
	question: z.string().min(1).max(8000),
});
export const drawingPlan = z.strictObject({
	action: z.enum(["create", "open", "library"]),
	referenceId: z.uuid().nullable(),
	revision: z.number().int().positive().nullable(),
	title: z.string().min(1).max(200),
});
