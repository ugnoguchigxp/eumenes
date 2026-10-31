import { useCallback } from "react";
import type { Settings } from "../../../api/domains/settings/contracts";
import { useTimerTone } from "../domains/audio";
import { completionVoiceWav, notificationSoundWav } from "../domains/settings";

/** Shares the output with speech; only explicitly successful notices append the completion voice. */
export function useNotificationAudio(
	settings: Settings["voice"] | undefined,
	sessionAudio?: Parameters<typeof useTimerTone>[1],
	speech?: Parameters<typeof useTimerTone>[2],
) {
	const audio = useTimerTone(
		{
			...settings,
			loadTone: (signal) =>
				notificationSoundWav(settings?.notificationSound, signal),
			loadCompletion: (signal) =>
				completionVoiceWav(settings?.completionVoice, signal),
		},
		sessionAudio,
		speech,
	);
	const play = audio.play,
		complete = audio.playCompletion;
	const chime = useCallback(
		(completed = false) => {
			void (completed ? complete : play)(new AbortController().signal).catch(
				() => {},
			);
		},
		[play, complete],
	);
	return { ...audio, chime };
}
