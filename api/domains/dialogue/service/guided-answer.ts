import { z } from "zod";
const delivered = z.object({
	delivery: z.literal("guided-web"),
	answer: z.string().trim().min(1).max(8000),
});
/** Only the host-issued answer ticket opts in. World and older reports use their existing path. */
export function guidedAnswer(
	projection: string | null | undefined,
): string | null {
	try {
		const result = delivered.safeParse(JSON.parse(projection ?? "null"));
		return result.success ? result.data.answer : null;
	} catch {
		return null;
	}
}
