import type { Config } from "../infrastructure/config";
import type { SettingsService } from "../domains/settings";
import { createLarmPlayground, type LarmPlayground } from "../domains/larm";
import type { Embed } from "./toolchain-vectors";

/**
 * Bind embedding to the saved LARM connection. The client (and its catalog cache) is reused
 * until the saved connection changes; the connection target is never taken from elsewhere.
 */
function larmEmbedder(
	create: () => LarmPlayground,
	connectionKey: () => string,
): Embed {
	let current: { key: string; client: LarmPlayground } | undefined;
	return (texts, type, signal) => {
		const key = connectionKey();
		if (current?.key !== key) current = { key, client: create() };
		return current.client.embed(texts, type, signal);
	};
}

export function createSavedEmbedder(config: Config, settings: SettingsService) {
	return larmEmbedder(
		() => {
			const s = settings.get();
			return createLarmPlayground({
				baseUrl: s.larm.baseUrl ?? undefined,
				token: config.larmToken,
				profile: s.larm.profile,
				audience: s.larm.audience,
				providerHosts: config.larmProviderHosts,
			});
		},
		() => {
			const s = settings.get();
			return JSON.stringify([s.larm.baseUrl, s.larm.profile, s.larm.audience]);
		},
	);
}
