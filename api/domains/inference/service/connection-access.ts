import type { Settings, SettingsService } from "../../settings";
import type { LarmPort } from "../../larm";
import type { ConnectionModelsService } from "./connection-models";
import { createImageInput } from "./image-input";

/** Public connection preparation/status; the LARM status keeps its existing meaning. */
export function connectionAccess(
	settings: Pick<SettingsService, "get">,
	port: (settings: Settings) => LarmPort,
	models?: ConnectionModelsService,
) {
	return {
		connect: () => port(settings.get()).connect(),
		prepareVoice: (signal: AbortSignal) =>
			port(settings.get()).prepareVoice?.(signal) ?? Promise.resolve(),
		status: () => port(settings.get()).status(),
		imageInput: createImageInput(settings, port, models),
	};
}
