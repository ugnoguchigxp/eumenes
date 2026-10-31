import type { SettingsService } from "../../settings";
import { systemContext } from "../../../infrastructure/system-context";

export function liveConfig(settings: SettingsService, requireModel = true) {
	const doc = settings.get();
	const live = doc.live;
	if (!live.enabled || !live.cloudAllowed)
		throw new Error("live_permission_required");
	const connection = doc.connections.find(
		(c) => c.id === live.connectionId && c.enabled,
	);
	if (
		!connection ||
		(connection.kind && connection.kind !== "openai-compatible") ||
		new URL(connection.baseUrl).origin !== "https://api.openai.com"
	)
		throw new Error("live_connection_invalid");
	if (requireModel && !live.model) throw new Error("live_model_required");
	const key = settings.credential(connection);
	if (!key) throw new Error("live_credential_missing");
	return { live, connection, key, persona: doc.general };
}
export function liveInstructions(
	config: ReturnType<typeof liveConfig>,
	persona: { role: string; style: string },
) {
	return systemContext("live-voice.contexts.session", {
		...persona,
		extra: config.live.instructions,
	});
}
