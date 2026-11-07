import { createDocling } from "../../domains/docling";
import type { SettingsService } from "../../domains/settings";

export function buildDocling(settings: SettingsService, credential?: string) {
	return createDocling({
		fileConnection() {
			const baseUrl = settings.get().larm.baseUrl;
			return baseUrl && credential ? { baseUrl, credential } : null;
		},
		connection() {
			const saved = settings.doclingCredentials(),
				larm = settings.get().larm;
			return saved && larm.baseUrl
				? { ...saved, version: `${larm.baseUrl}:${saved.version}` }
				: null;
		},
		status() {
			const saved = settings.doclingConnection();
			return {
				revision: saved.revision,
				publicOrigin: saved.publicOrigin,
				configured:
					!!saved.gatewayUrl &&
					saved.credentialConfigured &&
					!!settings.get().larm.baseUrl,
			};
		},
	});
}
