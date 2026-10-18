import { createLarm } from "../../larm";
import type { Settings } from "../../settings";
import type { InferenceOptions } from "./execute-types";

/** Shared construction for the saved settings port and in-flight settings snapshots. */
export function createConfiguredLarm(s: Settings, options: InferenceOptions) {
	return createLarm({
		baseUrl: s.larm.baseUrl ?? undefined,
		token: options.token,
		providerHosts: options.providerHosts,
		profile: s.larm.profile,
		audience: s.larm.audience,
		voice: s.larm.voice || undefined,
		speed: s.larm.speed,
		style: s.larm.style,
		pitchScale: s.larm.pitchScale,
		intonationScale: s.larm.intonationScale,
		judgeActivity: options.judgeActivity,
	});
}
