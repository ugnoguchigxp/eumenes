import { z } from "zod";

/** What a screen reports beside its visibility, for choosing the one screen that plays sound. */
export const screenDetailsSchema = z.object({
	/** How long ago (ms, on the screen's own clock) the user last pressed or typed on this screen. */
	gestureAgeMs: z.number().int().min(0).max(86_400_000).optional(),
	/** The screen holds the microphone's voice session. */
	voiceSession: z.boolean().optional(),
	/** The page is going away (pagehide or unmount); a later report (pageshow) brings it back. */
	leaving: z.boolean().optional(),
});
export type ScreenDetails = z.infer<typeof screenDetailsSchema>;
export const screenPresenceSchema = z
	.object({
		revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
		active: z.boolean(),
		sentAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
		...screenDetailsSchema.shape,
	})
	.strict();
export const playbackScreenSchema = z.object({ playbackScreen: z.boolean() });
