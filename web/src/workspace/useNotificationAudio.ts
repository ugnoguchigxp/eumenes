import { useCallback, useState } from "react";
import type { Settings } from "../../../api/domains/settings/contracts";
import { useTimerTone } from "../domains/audio";
import { completionVoiceWav, notificationSoundWav } from "../domains/settings";

/** Shares the output with speech; only explicitly successful notices append the completion voice. */
export function useNotificationAudio(
	settings: Settings["voice"] | undefined,
	sessionAudio?: Parameters<typeof useTimerTone>[1],
	speech?: Parameters<typeof useTimerTone>[2],
) {
	const [instanceId] = useState(() => crypto.randomUUID());
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
		(
			completed = false,
			notices?: { source: string; ids: readonly string[] },
		) => {
			const signal = new AbortController().signal;
			if (!completed) {
				void play(signal).catch(() => {});
				return;
			}
			const playbackId = crypto.randomUUID();
			// Browser-local diagnosis only: no message text, waveform, credentials or settings.
			const trace = (stage: string) => {
				try {
					console.info(
						"eumenes.completion_audio",
						JSON.stringify({
							instanceId,
							playbackId,
							stage,
							noticeSource: notices?.source,
							noticeIds: notices?.ids,
						}),
					);
				} catch {
					// Console availability cannot change notification delivery.
				}
			};
			trace("requested");
			void complete(signal, (part, phase) => trace(`${part}.${phase}`)).then(
				() => trace("finished"),
				() => trace("failed"),
			);
		},
		[play, complete, instanceId],
	);
	return { ...audio, chime };
}
