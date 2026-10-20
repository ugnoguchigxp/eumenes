import { z } from "zod";

/** The Web side of the browser source and `/api/browser/*` (spec browser-tabs-toolchain §9). */
export const BROWSER_SOURCE = "browser";

const connectionStates = ["disconnected", "connecting", "connected", "failed"];
const availability = z.union([
	z.looseObject({ available: z.literal(true) }),
	z.looseObject({ available: z.literal(false), reason: z.string() }),
]);
const browserConnection = z.looseObject({
	connectionId: z.string().nullable().optional(),
	state: z.enum(connectionStates as [string, ...string[]]),
	endReason: z.string().nullable(),
	configured: z.boolean(),
	availability,
});
export type BrowserConnectionData = z.infer<typeof browserConnection>;

const browserTab = z.looseObject({
	tabRef: z.string(),
	title: z.string(),
	url: z.string(),
	active: z.boolean(),
	status: z.enum(["idle", "busy", "closed", "blocked"]),
	currentTaskLabel: z.string().optional(),
});
export type BrowserTabData = z.infer<typeof browserTab>;

const scriptRevision = z.object({
	revision: z.number().int(),
	summary: z.string(),
	change: z.string().optional(),
	updatedAt: z.number(),
	steps: z.array(
		z.object({
			stepId: z.string(),
			label: z.string(),
			expectation: z.string(),
			state: z.enum(["pending", "running", "completed", "skipped"]),
			evidenceRef: z.string().optional(),
		}),
	),
});
const browserTask = z.looseObject({
	phase: z
		.enum([
			"preparing",
			"thinking",
			"connecting",
			"observing",
			"operating",
			"capturing",
		])
		.nullable()
		.optional(),
	operations: z
		.array(
			z.object({
				operationId: z.string(),
				sequence: z.number(),
				scriptRevision: z.number().nullable(),
				stepId: z.string().nullable(),
				toolKind: z.string(),
				state: z.enum([
					"prepared",
					"dispatched",
					"observed",
					"failed",
					"indeterminate",
				]),
				observedAt: z.number(),
				observationRef: z.string().nullable(),
				errorLabel: z.string().nullable(),
			}),
		)
		.optional(),
	taskId: z.string(),
	conversationId: z.string().optional(),
	continuedFrom: z.string().nullable().optional(),
	errorLabel: z.string().nullable().optional(),
	script: scriptRevision
		.extend({ history: z.array(scriptRevision) })
		.nullable()
		.optional(),
	requestSummary: z.string(),
	state: z.enum([
		"queued",
		"running",
		"completed",
		"needs_input",
		"failed",
		"cancelled",
		"expired",
		"indeterminate",
	]),
	resultSummary: z.string().optional(),
});

export const browserTaskList = z.object({ tasks: z.array(browserTask) });

const browserCapture = z.looseObject({
	captureId: z.string(),
	errorLabel: z.string().nullable().optional(),
	range: z.enum(["viewport", "full-page", "element"]),
	capturedAt: z.string(),
	width: z.number(),
	height: z.number(),
	bytes: z.number(),
	reductionPercent: z.number(),
	state: z.enum([
		"queued",
		"capturing",
		"encoding",
		"local_ready",
		"failed",
		"cancelled",
		"expired",
	]),
});
export type BrowserCaptureData = z.infer<typeof browserCapture>;

export const browserSourceData = z.looseObject({
	connection: browserConnection,
	tabs: z.array(browserTab),
	tasks: z.array(browserTask),
	captures: z.array(browserCapture),
});
export type BrowserSourceData = z.infer<typeof browserSourceData>;

export const browserTabList = z.looseObject({ tabs: z.array(browserTab) });
export const browserSetting = z.looseObject({
	executablePath: z.string().nullable(),
	/** A standard Brave install that exists; only while no path is saved, and only on reads. */
	suggestedPath: z.string().nullable().optional(),
	/** Whether the backend can open the OS file dialog for choosing Brave. */
	canBrowse: z.boolean().optional(),
});
export const browserBrowseResult = z.looseObject({
	path: z.string().nullable(),
});
