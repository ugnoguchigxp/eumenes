import { useCallback, useEffect, useRef, useState } from "react";
import type { Settings } from "../../../api/domains/settings/contracts";
import { useTimerTone, type ScreenOutput } from "../domains/audio";
import { completionVoiceWav, notificationSoundWav } from "../domains/settings";

/** The screen that a notice sounds on: its output, whether it plays sound, and the backend claim. */
export type NoticeScreen = {
	output: ScreenOutput;
	playback: () => boolean;
	claim: (sourceKey: string) => Promise<boolean>;
};

/**
 * Shares the output with speech; only explicitly successful notices append the completion voice. A
 * notice sounds only on the playback screen, once: it is claimed on the backend first (spec
 * tts-single-lane §4.2–4.4).
 */
export function useNotificationAudio(
	settings: Settings["voice"] | undefined,
	sessionAudio?: Parameters<typeof useTimerTone>[1],
	speech?: Parameters<typeof useTimerTone>[2],
	screen?: NoticeScreen,
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
		true,
		screen?.output,
	);
	const gate = useRef(screen);
	useEffect(() => {
		gate.current = screen;
	}, [screen]);
	const play = audio.play,
		complete = audio.playCompletion;
	const sound = useCallback(
		(
			completed: boolean,
			notices?: { source: string; ids: readonly string[] },
		) => {
			// A notice that cannot sound within a minute (speech kept going) is dropped, not saved up.
			const signal = AbortSignal.timeout(60_000);
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
	const chime = useCallback(
		(
			completed = false,
			notices?: { source: string; ids: readonly string[] },
		) => {
			const screen = gate.current;
			// Another screen plays sound; this one only shows the notice.
			if (screen && !screen.playback()) return;
			const first = notices && [...notices.ids].sort()[0];
			if (screen && notices && first) {
				void screen
					.claim(`notice:${notices.source}:${first}`)
					.then((claimed) => {
						if (claimed) sound(completed, notices);
					})
					.catch(() => {});
				return;
			}
			sound(completed, notices);
		},
		[sound],
	);
	return { ...audio, chime };
}
