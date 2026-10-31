import { z } from "zod";
/** Saved presentation settings; demo values never claim to be telemetry. */
export const spatialSettingsShape = {
	spatialScatter: z.number().min(0).max(500).optional(),
	spatialCore: z.number().min(10).max(90).optional(),
	spatialFocusCore: z.number().min(10).max(90).optional(),
	spatialPointSize: z.number().min(50).max(200).optional(),
	spatialOpacity: z.number().min(20).max(100).optional(),
	spatialOrbitSpeed: z.number().min(0).max(200).optional(),
	spatialSpinSpeed: z.number().min(0).max(100).optional(),
	spatialPaused: z.boolean().optional(),
	spatialReducedMotion: z.boolean().optional(),
	spatialView: z.enum(["oblique", "top"]).optional(),
	spatialDemoEnabled: z.boolean().optional(),
	spatialDemoHealth: z
		.enum(["healthy", "pressure", "fault", "disconnected", "unknown"])
		.optional(),
	spatialDemoActivity: z.enum(["idle", "starting", "working"]).optional(),
	spatialDemoUtilization: z.number().min(0).max(100).optional(),
	spatialDemoStrength: z.number().min(0).max(100).optional(),
	spatialDemoStale: z.boolean().optional(),
};
