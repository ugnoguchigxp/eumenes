import type { LarmPort } from "../../larm";
import type { SettingsService, Settings } from "../../settings";
import type { ImageInputStatus } from "../contracts/image-input";
import type { ConnectionModelsService } from "./connection-models";
import { imageSupport } from "./cloud-images";

/** Inspect the selected route, keeping local and permitted fallback capabilities separate. */
export function createImageInput(
	settings: Pick<SettingsService, "get">,
	port: (settings: Settings) => LarmPort,
	models?: ConnectionModelsService,
) {
	return async (signal: AbortSignal): Promise<ImageInputStatus> => {
		const snapshot = settings.get();
		const route = snapshot.routes.llm;
		const cloud = async (): Promise<ImageInputStatus["primary"]> => {
			const resource = snapshot.resources.find(
				(r) => r.id === route.fallbackId && r.purpose === "llm",
			);
			const connection = snapshot.connections.find(
				(c) => c.id === resource?.connectionId && c.enabled,
			);
			const source = connection?.kind ?? "openai-compatible";
			if (!resource || !connection || !route.cloudAllowed)
				return { source, status: "unsupported" };
			try {
				return {
					source,
					status: imageSupport(
						(await models?.list(connection.id, signal)) ?? null,
						resource,
					),
				};
			} catch {
				signal.throwIfAborted();
				return { source, status: "failed" };
			}
		};
		let primary: ImageInputStatus["primary"];
		if (route.mode === "cloud-only") primary = await cloud();
		else {
			const local = port(snapshot);
			try {
				await local.connect();
				signal.throwIfAborted();
				const status = local.status();
				primary = {
					source: "larm",
					status: status.chatInput ? "supported" : "unknown",
					...(status.chatInput ? { chatInput: status.chatInput } : {}),
				};
			} catch {
				signal.throwIfAborted();
				primary = { source: "larm", status: "failed" };
			}
		}
		const fallback =
			route.mode === "larm-preferred" && route.cloudAllowed
				? await cloud()
				: undefined;
		signal.throwIfAborted();
		if (settings.get().revision !== snapshot.revision)
			throw new Error("stale_connection_settings");
		return {
			revision: snapshot.revision,
			primary,
			...(fallback ? { fallback } : {}),
		};
	};
}
