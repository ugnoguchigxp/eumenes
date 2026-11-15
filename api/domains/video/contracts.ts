import { z } from "zod";
import {
	videoArtifact,
	videoInput,
	videoJob,
	videoOptions,
} from "../larm/contracts";

export {
	videoArtifact,
	videoId,
	videoInput,
	videoList,
	videoMetadata,
	videoOptions,
	type VideoInput,
} from "../larm/contracts";

export const videoRequestView = z.object({
	id: z.uuid(),
	title: z.string().optional(),
	state: z.enum([
		"submitting",
		"unconfirmed",
		"rejected",
		"tracking",
		"finished",
	]),
	job: videoJob.omit({ statusUrl: true, eventsUrl: true }).nullable(),
	errorCode: z.string().nullable(),
	revision: z.number().int().nonnegative(),
});
export type VideoRequestView = z.infer<typeof videoRequestView>;
export const videoAdmission = z.object({
	state: z.enum(["idle", "active", "unconfirmed", "isolated"]),
});
export type VideoAdmission = z.infer<typeof videoAdmission>;
export const videoWorkspace = z.object({
	request: videoRequestView.nullable(),
	admission: videoAdmission,
});
export const videoServiceInfo = z.object({
	model: z.string(),
	description: z.string(),
	options: videoOptions,
});
export const videoCommandReceipt = z.object({
	action: z.enum(["open", "generate"]),
	requestId: z.uuid().optional(),
});
export type VideoCommandReceipt = z.infer<typeof videoCommandReceipt>;

/** Only the submitted fields are returned as metadata; additional upstream fields stay private. */
export const videoRequestMetadata = z.object({
	...videoInput.shape,
	model: z.string().optional(),
});
export const videoMetadataView = videoArtifact.extend({
	request: videoRequestMetadata.optional(),
});
