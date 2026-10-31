import { useCallback, useEffect, useRef, useState } from "react";
import {
	defaultNotificationSound,
	notificationSoundOptions,
	completionVoiceOptions,
	type Settings,
} from "../../../../api/domains/settings/contracts";
import { notificationSoundWav, completionVoiceWav } from "../settings";
import { useTimerTone } from "../audio";

/** Preview the current draft through the same output path as a real notification. */
export function useNotificationSample(
	settings: Settings["voice"] | undefined,
	active: boolean,
	kind: "notification" | "completion" = "notification",
) {
	const available =
		kind === "completion"
			? !!settings?.completionVoice &&
				settings.completionVoice !== "none" &&
				completionVoiceOptions.some(
					(option) => option.value === settings.completionVoice,
				)
			: notificationSoundOptions.some(
					(option) =>
						option.value ===
						(settings?.notificationSound ?? defaultNotificationSound),
				);
	const tone = useTimerTone(
		{
			...settings,
			loadTone: (signal) =>
				kind === "completion"
					? completionVoiceWav(settings?.completionVoice, signal)
					: notificationSoundWav(settings?.notificationSound, signal),
		},
		undefined,
		undefined,
		false,
	);
	const run = useRef<AbortController | null>(null);
	const target = JSON.stringify([
		kind,
		settings?.completionVoice,
		settings?.notificationSound,
		settings?.outputDevice,
		settings?.outputVolume,
		active,
	]);
	const [snapshot, setSnapshot] = useState({
		target,
		playing: false,
		error: "",
	});
	const playing = snapshot.target === target && snapshot.playing;
	const error = snapshot.target === target ? snapshot.error : "";
	const release = useCallback(() => {
		run.current?.abort();
		run.current = null;
	}, []);
	const stop = () => {
		release();
		setSnapshot({ target, playing: false, error: "" });
	};
	// A new selection owns its UI state; the effect only releases external playback.
	useEffect(() => release, [target, release]);
	async function play() {
		if (!active || !available) return;
		stop();
		const mine = new AbortController();
		run.current = mine;
		setSnapshot({ target, playing: true, error: "" });
		try {
			await tone.prepare();
			mine.signal.throwIfAborted();
			await tone.play(mine.signal);
		} catch {
			if (run.current === mine && !mine.signal.aborted)
				setSnapshot({
					target,
					playing: false,
					error:
						"通知音を再生できませんでした。音量・再生機器・ブラウザの音声許可を確認してください。",
				});
		} finally {
			if (run.current === mine) {
				run.current = null;
				setSnapshot((current) =>
					current.target === target ? { ...current, playing: false } : current,
				);
			}
		}
	}
	return { playing, error, play, stop, available };
}
