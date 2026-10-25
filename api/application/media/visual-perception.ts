import { createVisualPerception } from "../../domains/larm";
import type { SettingsService } from "../../domains/settings";
import type { Config } from "../../infrastructure/config";
/** Saved connection and backend credential are resolved at the application boundary. */
export function buildVisualPerception(
	config: Pick<Config, "larmToken" | "larmProviderHosts">,
	settings: SettingsService,
) {
	return () => {
		const saved = settings.get().larm;
		return createVisualPerception({
			baseUrl: saved.baseUrl ?? undefined,
			profile: saved.profile,
			audience: saved.audience,
			token: config.larmToken,
			providerHosts: config.larmProviderHosts,
		});
	};
}
