import { z } from "zod";

/** The diagnostic text of a failed run (`GET /api/runs/:id/error-report`); built from IDs and fixed codes only. */
export const errorReportSchema = z.object({
	runId: z.string(),
	text: z.string(),
});
