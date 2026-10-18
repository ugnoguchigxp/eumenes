import { z } from "zod";

/** The Web side of the browser source and `/api/browser/*` (spec browser-tabs-toolchain §9). */
export const BROWSER_SOURCE = "browser";

const connectionStates = ["disconnected", "connecting", "connected", "failed"];
const availability = z.union([
	z.looseObject({ available: z.literal(true) }),
	z.looseObject({ available: z.literal(false), reason: z.string() }),
]);
const browserConnection = z.looseObject({
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

const browserTask = z.looseObject({
	taskId: z.string(),
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

const browserCapture = z.looseObject({
	captureId: z.string(),
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
});
