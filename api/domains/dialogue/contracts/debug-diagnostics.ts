import { z } from "zod";

export const debugDiagnosticSchema = z.object({
	id: z.string(),
	runId: z.string(),
	at: z.string(),
	expiresAt: z.number(),
	summary: z.string().nullable(),
});
export const debugDiagnosticsSchema = z.object({
	entries: z.array(debugDiagnosticSchema),
	omitted: z.number(),
});
export const debugDiagnosticDetailSchema = debugDiagnosticSchema.extend({
	observation: z.string(),
});
export type DebugDiagnosticDetail = z.infer<typeof debugDiagnosticDetailSchema>;
