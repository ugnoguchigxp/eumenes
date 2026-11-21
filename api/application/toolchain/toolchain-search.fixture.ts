import type { SqliteStore } from "../../infrastructure/sqlite";
import { fixtureDiscovery } from "./discovery.fixture";
import { createToolchainRouting } from "./toolchain-routing";
import type { HarnessOptions } from "./toolchain-harness-options.fixture";
import type { createToolchain } from "./toolchain";

/** Reuse the actual Toolchain search with fixture embeddings where provided. */
export async function fixtureRouting(input: {
	options: HarnessOptions;
	toolchain: Awaited<ReturnType<typeof createToolchain>>;
	store: SqliteStore;
}) {
	const { options, toolchain, store } = input;
	const discovery = (query: string) =>
		options.discoveryTarget?.(query) ??
		(options.history
			? "conversation_history"
			: (options.routeTool ??
				(options.uiCompositions
					? "ui_create"
					: options.weather && /天気/.test(query)
						? "weather_forecast"
						: options.stock && /株価/.test(query)
							? "stock_quote"
							: options.timers && /タイマー/.test(query)
								? "timer"
								: "service_search")));
	const routing = createToolchainRouting(
		toolchain.capabilities,
		toolchain.history,
		options.embed || options.liveRouting
			? toolchain.embedQuery
			: fixtureDiscovery(store, toolchain.capabilities, discovery),
		toolchain.registry,
		toolchain.schemas,
	);
	if (options.liveRouting && options.embed) await toolchain.refreshVectors();
	return routing;
}
