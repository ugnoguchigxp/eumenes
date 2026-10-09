import { z } from "zod";

const label = z.string().trim().min(1).max(80);
export const timerStates = ["active", "elapsed", "cancelled"] as const;

export const timerStart = z
	.object({
		durationSeconds: z.number().int().min(1).max(86400),
		label: label.optional(),
	})
	.strict();
export const timerList = z
	.object({
		timerId: z.uuid().optional(),
		state: z.enum(timerStates).optional(),
	})
	.strict();
export const timerCancel = z
	.object({
		timerId: z.uuid(),
		expectedRevision: z.number().int().min(0),
	})
	.strict();
export const timerCommand = z.discriminatedUnion("operation", [
	timerStart.extend({ operation: z.literal("start") }),
	timerList.extend({ operation: z.literal("list") }),
	timerCancel.extend({ operation: z.literal("cancel") }),
]);
