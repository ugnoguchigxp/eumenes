import { z } from "zod";
const packId = z.string().regex(/^dots\.user\.[a-f0-9]{32}$/);
export const dotsPackageInput = z.strictObject({
	id: packId,
	expectedToken: z.string().nullable(),
	title: z.string().trim().min(1).max(120),
	summary: z.string().trim().min(1).max(600),
	profile: z.string().trim().min(1).max(8000),
	skills: z
		.array(
			z.strictObject({
				title: z.string().trim().min(1).max(120),
				body: z.string().trim().min(1).max(8000),
			}),
		)
		.min(1)
		.max(4),
	enabled: z.boolean(),
});
