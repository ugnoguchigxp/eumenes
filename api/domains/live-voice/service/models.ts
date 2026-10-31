import type { SettingsService } from "../../settings";
import { readBounded } from "../../../infrastructure/bounded-read";
import { liveConfig } from "./config";
export async function fetchModels(
	settings: SettingsService,
	signal: AbortSignal,
) {
	const cfg = liveConfig(settings, false);
	try {
		const response = await fetch("https://api.openai.com/v1/models", {
			headers: { Authorization: `Bearer ${cfg.key}` },
			signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
			redirect: "error",
		});
		if (!response.ok) throw new Error("live_model_catalog_failed");
		const bytes = await readBounded(response.body, {
			limit: 2_000_000,
			missing: "live_model_catalog_failed",
			tooLarge: "live_model_catalog_failed",
		});
		const parsed = JSON.parse(new TextDecoder().decode(bytes)) as {
			data?: Array<{ id?: unknown }>;
		};
		if (!Array.isArray(parsed.data))
			throw new Error("live_model_catalog_failed");
		return {
			models: parsed.data
				.flatMap((m) =>
					typeof m.id === "string" && m.id.length <= 200 ? [m.id] : [],
				)
				.slice(0, 500),
		};
	} catch {
		throw new Error("live_model_catalog_failed");
	}
}
