import { z } from "zod";

export const appReviewInput = z.strictObject({
	expectedRevision: z.number().int().nonnegative(),
	skill: z.enum(["skill:review.human-factors@1", "skill:review.workflow@1"]),
});
