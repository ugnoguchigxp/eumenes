import { z } from "zod";
export const prototypeScreenRef = "adapter:prototype-task@1";

export const registration = z.object({
	id: z.uuid(),
	name: z.string(),
	root: z.string(),
	generation: z.number().int(),
	trial: z.object({ entry: z.string(), environment: z.string() }).optional(),
});
export const prototypePreview = z.object({
	state: z.enum([
		"waiting",
		"building",
		"ready",
		"failed",
		"unresponsive",
		"hidden",
		"environment",
		"registration",
		"unsupported",
	]),
	url: z.string().nullable(),
	version: z.string().nullable(),
	diagnostics: z.array(z.string()),
});
export const prototypeStatus = z.object({
	projects: z.array(registration),
	defaultVersion: z.string(),
});
export type PrototypePreview = z.output<typeof prototypePreview>;
export type PrototypeRegistration = z.output<typeof registration>;

export const worksImagePolicy = z.object({
	revision: z.int().nonnegative(),
	canGenerate: z.boolean(),
	canRead: z.boolean(),
	enabled: z.boolean(),
	assets: z
		.array(
			z.object({ id: z.string().min(1).max(160), label: z.string().max(200) }),
		)
		.max(16),
});
export const worksImagePolicyChange = z.strictObject({
	expectedRevision: z.int().nonnegative(),
	enabled: z.boolean(),
	assetIds: z.array(z.string().min(1).max(160)).max(16),
});

export const trialRequest = z.strictObject({
	path: z.string().min(1).max(2048),
	name: z.string().trim().min(1).max(100),
	environment: z.string().regex(/^[1-9]\d*\.\d+$/),
	entry: z.string().min(1).max(300),
	mountId: z
		.string()
		.regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)
		.optional(),
	include: z.array(z.string().min(1).max(300)).min(1).max(16),
});
export type TrialRequest = z.output<typeof trialRequest>;
export const trialInventoryView = z.object({
	missing: z.array(z.string()),
	versionDifferences: z.array(
		z.object({ name: z.string(), declared: z.string(), shared: z.string() }),
	),
	originalCommands: z.array(z.string()),
	configuration: z.array(z.string()),
	unsupported: z.array(z.string()),
});
