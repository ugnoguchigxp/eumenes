import { z } from "zod";
export const computeViewRegistry = {
	"compute-workspace": {
		name: "ComputeWorkspace",
		label: "計算の状態と成果物",
		schema: z.strictObject({
			view: z.literal("compute-workspace"),
			source: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
			title: z.string().max(480).optional(),
		}),
	},
};
