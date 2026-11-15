import { useEffect, useRef } from "react";
import type { Settings } from "../../../api/domains/settings/contracts";

/** Saved permission epochs own both recognition and playback; old results must lose both. */
export function useVoiceSettingsRevocation(
	settings: Settings | undefined,
	stopVoice: () => Promise<void>,
	stopReplay: () => void,
) {
	const previous = useRef(settings);
	useEffect(() => {
		const old = previous.current;
		previous.current = settings;
		if (!old || !settings || old.revision === settings.revision) return;
		const revoked =
			(["llm", "asr", "tts"] as const).some(
				(p) => old.routes[p].epoch !== settings.routes[p].epoch,
			) ||
			old.connections.some((c) => {
				const next = settings.connections.find((next) => next.id === c.id);
				return !next || next.epoch !== c.epoch || (c.enabled && !next.enabled);
			});
		if (revoked) {
			stopReplay();
			void stopVoice();
		}
	}, [settings, stopVoice, stopReplay]);
}
