import { z } from "zod";
import { larmViewSchema } from "./larm";
export type { LarmView } from "./larm";

/** The Spatial shape each monitored item is drawn with; `network` draws the Eumenes backend. */
export const monitoringShapes = [
	"cpu",
	"memory",
	"ssd",
	"network",
	"llm",
	"asr",
	"tts",
	"embedding",
	"attitude",
	"image",
	"music",
	"larm-core",
	"larm-cpu",
	"larm-memory",
	"larm-gpu",
] as const;
export type MonitoringShape = (typeof monitoringShapes)[number];

export const monitoringHealthSchema = z.enum([
	"healthy",
	"pressure",
	"fault",
	"disconnected",
	"unknown",
]);

export const monitoringItemSchema = z.object({
	/** Instance id chosen by the backend; never a Spatial shape sample id. */
	id: z.string(),
	shape: z.enum(monitoringShapes),
	label: z.string(),
	state: z.object({
		health: monitoringHealthSchema,
		activity: z.enum(["idle", "starting", "working"]),
		/** 0–1; absent when not measured (never 0 for "unknown"). */
		utilization: z.number().min(0).max(1).optional(),
		/** Machine-readable code of the newest failure behind a fault or disconnection. */
		reason: z.string().optional(),
		stale: z.boolean().optional(),
		/** Saved route and actual recent outcomes; configuration alone is not a successful probe. */
		service: z
			.object({
				mode: z.enum(["larm-preferred", "larm-only", "cloud-only"]),
				cloudAllowed: z.boolean().optional(),
				connectionName: z.string().optional(),
				model: z.string().optional(),
				running: z.number().int().nonnegative(),
				lastSuccessAt: z.number().nullable(),
				lastFailure: z
					.object({ at: z.number(), reason: z.string() })
					.nullable(),
			})
			.optional(),
		observations: z
			.array(
				z.object({
					status: z.enum([
						"ok",
						"stale",
						"unsupported",
						"permission_denied",
						"error",
						"unavailable",
					]),
					observedAt: z.number().nullable(),
					ageMs: z.number().nonnegative(),
					maxAgeMs: z.number().positive(),
				}),
			)
			.optional(),
		diagnostics: z.array(z.string()).optional(),
		faultRemainingMs: z.number().nonnegative().optional(),
		settledHealth: monitoringHealthSchema.optional(),
	}),
});
export type MonitoringItem = z.infer<typeof monitoringItemSchema>;

export const monitoringSnapshotSchema = z.object({
	observedAt: z.number(),
	items: z.array(monitoringItemSchema),
	larm: larmViewSchema.optional(),
});
export type MonitoringSnapshot = z.infer<typeof monitoringSnapshotSchema>;
