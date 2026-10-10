import { useCallback, useEffect, useRef, useState } from "react";
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
	const [ready, setReadyState] = useState(false);
	const readyRef = useRef(false);
	const setReady = useCallback((value: boolean) => {
		readyRef.current = value;
		setReadyState(value);
	}, []);
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
	const ensureOutput = useCallback(
		(outputDevice: string) => {
			if (output.current?.device !== outputDevice) {
				// A changed device needs a fresh preparation on the next gesture.
				if (output.current) setReady(false);
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
		},
		[setReady],
	);
	const prepare = useCallback(async () => {
		const { settings: audio, sessionAudio: session } = latest.current;
		if ((audio.outputVolume ?? 1) <= 0) return;
		if (session?.()) {
			setReady(true);
			return;
		}
		const owned = ensureOutput(audio.outputDevice ?? "");
		try {
			await owned.audio.startOutput();
			if (output.current === owned) setReady(true);
		} catch (error) {
			if (output.current === owned) {
				release();
				setReady(false);
			}
			throw error;
		}
	}, [ensureOutput, release, setReady]);
	useEffect(() => {
		// Finish the gesture before hiding the preparation card. Preparing on pointerdown
		// can remove a pressed button before its click and send the click to another card.
		let lastFailure = Number.NEGATIVE_INFINITY;
		const unlock = () => {
			if (readyRef.current) return;
			// A rejecting output must not be rebuilt on every key press.
			if (Date.now() - lastFailure < 5_000) return;
			void prepare().catch(() => {
				lastFailure = Date.now();
			});
		};
		window.addEventListener("click", unlock, { capture: true });
		window.addEventListener("keyup", unlock, { capture: true });
		return () => {
			window.removeEventListener("click", unlock, { capture: true });
			window.removeEventListener("keyup", unlock, { capture: true });
		};
	}, [prepare]);
	const playTone = useCallback(
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
	const repeat = useCallback(
		async (signal: AbortSignal) => {
			while (!signal.aborted) {
				await new Promise<void>((resolve, reject) => {
					const abort = () => {
						clearTimeout(timer);
						reject(new Error("audio_interrupted"));
					};
					const timer = setTimeout(() => {
						signal.removeEventListener("abort", abort);
						resolve();
					}, 2500);
					signal.addEventListener("abort", abort, { once: true });
					if (signal.aborted) abort();
				});
				await playTone(signal);
			}
		},
		[playTone],
	);
	return { play: playTone, repeat, ready, prepare };
}
