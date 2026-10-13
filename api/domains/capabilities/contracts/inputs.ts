import { z } from "zod";

/** Free-text answer to an open question of a bound command (`builtin:answerText`). */
export const answerText = z.strictObject({
	text: z.string().trim().min(1).max(500),
});
/** An operation that takes no input of its own; the host supplies the target (`builtin:emptyInput`). */
export const emptyInput = z.strictObject({});
