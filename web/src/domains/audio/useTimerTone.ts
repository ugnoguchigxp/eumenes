import { useCallback, useEffect, useRef } from "react";
import {
	createAudioController,
	type AudioController,
	type OutputController,
} from "./controller";
import { timerToneWav } from "./tone";

/** Reuses configured output; the caller defers notices while voice/replay is busy. */
export function useTimerTone(
	settings: { outputDevice?: string; outputVolume?: number } = {},
	sessionAudio?: () => Pick<AudioController, "play" | "stopPlayback"> | null,
	speech?: (text: string, signal: AbortSignal) => Promise<Uint8Array>,
) {
	const latest = useRef({ settings, sessionAudio, speech });
	useEffect(() => {
		latest.current = { settings, sessionAudio, speech };
	}, [settings, sessionAudio, speech]);
	const output = useRef<{ device: string; audio: OutputController } | null>(
		null,
	);
	const release = useCallback(() => {
		const owned = output.current;
		output.current = null;
		void owned?.audio.stop();
	}, []);
	useEffect(() => () => release(), [release]);
	const ensureOutput = useCallback((outputDevice: string) => {
		if (output.current?.device !== outputDevice) {
			void output.current?.audio.stop();
			output.current = {
				device: outputDevice,
				audio: createAudioController(
					() => {},
					() => {},
					() => {},
					{ outputDevice, keepAlive: false },
				),
			};
		}
		return output.current!;
	}, []);
	useEffect(() => {
		// Prepare output inside a user gesture so the later alarm is allowed by autoplay rules.
		const unlock = () => {
			const { settings: audio, sessionAudio: session } = latest.current;
			if ((audio.outputVolume ?? 1) <= 0 || session?.()) return;
			if (output.current?.device === (audio.outputDevice ?? "")) return;
			const owned = ensureOutput(audio.outputDevice ?? "");
			void owned.audio.startOutput().catch(() => {
				if (output.current === owned) release();
			});
		};
		window.addEventListener("pointerdown", unlock, { capture: true });
		window.addEventListener("keydown", unlock, { capture: true });
		return () => {
			window.removeEventListener("pointerdown", unlock, { capture: true });
			window.removeEventListener("keydown", unlock, { capture: true });
		};
	}, [ensureOutput, release]);
	return useCallback(
		async (
			signal: AbortSignal,
			message?: string,
			onToneDelivered?: () => void,
		) => {
			signal.throwIfAborted();
			const { outputDevice = "", outputVolume = 1 } = latest.current.settings;
			if (outputVolume <= 0) throw new Error("audio_muted");
			const session = latest.current.sessionAudio?.();
			if (!session) ensureOutput(outputDevice);
			const owned = session ? null : output.current!;
			const target = session ?? owned!.audio;
			const play = (bytes: Uint8Array, playbackSignal: AbortSignal = signal) =>
				new Promise<void>((resolve, reject) => {
					let started = false;
					const finish = (error?: Error) => {
						playbackSignal.removeEventListener("abort", abort);
						if (error) reject(error);
						else resolve();
					};
					const abort = () => {
						target.stopPlayback();
						if (owned) {
							void owned.audio.stop();
							if (output.current === owned) output.current = null;
						}
						finish(new Error("audio_interrupted"));
					};
					playbackSignal.addEventListener("abort", abort, { once: true });
					if (playbackSignal.aborted) {
						abort();
						return;
					}
					void (async () => {
						try {
							if (owned) await owned.audio.startOutput();
							playbackSignal.throwIfAborted();
							await target.play(bytes, () => finish(), {
								volume: Math.min(1, outputVolume),
								suppressInput: true,
								shouldPlay: () => !playbackSignal.aborted,
								onStarted: () => {
									started = true;
								},
								onInterrupted: () => finish(new Error("audio_interrupted")),
							});
							if (!started) finish(new Error("audio_not_started"));
						} catch (error) {
							if (owned) {
								void owned.audio.stop();
								if (output.current === owned) output.current = null;
							}
							finish(
								error instanceof Error ? error : new Error("audio_blocked"),
							);
						}
					})();
				});
			await play(timerToneWav());
			onToneDelivered?.();
			// Speech is best effort: an unavailable TTS provider must not erase a delivered beep.
			if (message && latest.current.speech) {
				const speechAbort = new AbortController();
				const abortSpeech = () => speechAbort.abort();
				signal.addEventListener("abort", abortSpeech, { once: true });
				const timeout = setTimeout(abortSpeech, 6000);
				try {
					signal.throwIfAborted();
					const wav = await latest.current.speech(message, speechAbort.signal);
					await play(wav, speechAbort.signal);
				} catch {
					signal.throwIfAborted();
				} finally {
					clearTimeout(timeout);
					signal.removeEventListener("abort", abortSpeech);
				}
			}
		},
		[ensureOutput],
	);
}
