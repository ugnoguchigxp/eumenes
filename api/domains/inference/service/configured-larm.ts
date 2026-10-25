import { createHmac } from "node:crypto";
import { createLarm } from "../../larm";
import type { Settings } from "../../settings";
import type { InferenceOptions } from "./execute-types";

/**
 * The LARM client of these saved settings, the same across restarts of this installation: LARM returns a live
 * connection of the same client and profile, with its input cache. Undefined without the settings key.
 */
export function stableLarmClient(
	key: Uint8Array | undefined,
	larm: Pick<Settings["larm"], "baseUrl" | "profile" | "audience">,
) {
	if (!key) return undefined;
	const digest = createHmac("sha256", key)
		.update(JSON.stringify([larm.baseUrl, larm.profile, larm.audience]))
		.digest("hex");
	return `eumenes-${digest.slice(0, 32)}`;
}

/** Shared construction for the saved settings port and in-flight settings snapshots. */
export function createConfiguredLarm(
	s: Settings,
	options: InferenceOptions,
	client?: string,
) {
	return createLarm({
		...(options.keepLarmConnection ? { keepAlive: true, client } : {}),
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

/** Whether the port saved under `name` (its LARM settings as JSON) has the client, so the connection, of any of `others`. */
export function sharesLarmClient(
	key: Uint8Array | undefined,
	name: string,
	others: readonly Settings["larm"][],
): boolean {
	const own = stableLarmClient(key, JSON.parse(name) as Settings["larm"]);
	return (
		own !== undefined &&
		others.some((other) => stableLarmClient(key, other) === own)
	);
}
