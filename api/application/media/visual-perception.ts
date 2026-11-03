import { createVisualPerception } from "../../domains/larm";
import type { SettingsService } from "../../domains/settings";
import type { Config } from "../../infrastructure/config";
import type { SqliteStore } from "../../infrastructure/sqlite";
import type { QueueService } from "../../domains/queue";
import { createAnalysisFactory } from "./analysis";
/** Saved connection and backend credential are resolved at the application boundary. */
function buildVisualPerception(
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

/** Both source owners use the same saved settings and analysis execution composition. */
export function buildAnalysisFactory(
	config: Pick<Config, "larmToken" | "larmProviderHosts">,
	settings: SettingsService,
	store: SqliteStore,
	queue: QueueService,
) {
	return createAnalysisFactory(
		store,
		queue,
		buildVisualPerception(config, settings),
	);
}
