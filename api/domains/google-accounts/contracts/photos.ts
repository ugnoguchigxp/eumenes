import { z } from "zod";
export const photosView = z.object({
	handle: z.uuid(),
	pickerUri: z.string(),
	status: z.enum(["pending", "ready", "expired"]),
	pollAfterMs: z.number().nonnegative(),
	timeoutAt: z.number(),
	items: z
		.array(
			z.object({ id: z.string(), title: z.string(), thumbnailUrl: z.string() }),
		)
		.max(1),
});
export type PhotosView = z.infer<typeof photosView>;
