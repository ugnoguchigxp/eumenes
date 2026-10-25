import { z } from "zod";
import { musicPlaybackPlan } from "./music";

/**
 * V2 adds the tracks the request carried (resource-uri plan §6.4): `music.track` and `music.playlist` URIs
 * copied from the request's references. With any URI the host opens exactly those tracks and does not search;
 * an empty list is the V1 library search. V1 stays immutable for installed revisions and queued work.
 */
export const musicPlaybackPlanV2 = musicPlaybackPlan.extend({
	trackUris: z
		.array(z.string().min(1).max(512).meta({ format: "eumenes-uri" }))
		.max(50)
		.default([])
		.describe(
			"依頼に添えられた曲（music.track）またはプレイリスト（music.playlist）のURI。写すだけで、作らない・書き換えない。なければ[]。",
		),
});
