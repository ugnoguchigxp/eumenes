import { useEffect } from "react";
import type { EumenesClient } from "../../../client";
import type { Settings } from "../../../api/domains/settings/contracts";
import { useLiveVoice } from "../domains/live-voice";
/** The main controls also observe test sessions started in the settings panel. */
export function useWorkspaceLive(
	client: EumenesClient,
	settings: Settings | undefined,
	voice: { active: boolean; stop: () => Promise<void> },
	replay: { stop: () => void },
) {
	const { active, stop: stopVoice } = voice;
	const { stop: stopReplay } = replay;
	const live = useLiveVoice(client, settings, async () => {
		stopReplay();
		await stopVoice();
	});
	useEffect(() => {
		if (live.active) {
			stopReplay();
			if (active) void stopVoice();
		}
	}, [live.active, stopReplay, active, stopVoice]);
	return live;
}
