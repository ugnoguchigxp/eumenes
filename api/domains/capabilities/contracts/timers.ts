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

export const timerResultContext = z
	.object({
		version: z.literal(1),
		kind: z.literal("timer_action"),
		action: z.enum([
			"started",
			"listed",
			"cancelled",
			"dismissed",
			"unchanged",
			"failed",
		]),
		observedAt: z.iso.datetime({ offset: true }),
		items: z
			.array(
				z
					.object({
						id: z.uuid(),
						revision: z.number().int().nonnegative(),
						label: z.string().max(80),
						state: z.enum(timerStates),
						durationSeconds: z.number().int().min(1).max(86400),
						remainingSeconds: z.number().int().min(0).max(86400),
						dueAt: z.iso.datetime({ offset: true }),
					})
					.strict(),
			)
			.max(50),
		complete: z.boolean(),
		errorCode: z
			.string()
			.regex(/^[a-z_]{1,80}$/)
			.nullable(),
	})
	.strict();
export type TimerResultContext = z.infer<typeof timerResultContext>;
