import { useCallback, useEffect, useRef, useState } from "react";
import type { AudioController } from "./controller";
import { createScreenOutput, type ScreenOutput } from "./screen-output";
import { timerToneWav } from "./tone";

type PlaybackTrace = (
	part: "tone" | "completion",
	phase: "started" | "ended",
) => void;

/**
 * Reuses configured output; the caller defers notices while voice/replay is busy. Each sound is a
 * notice of the screen's output (spec tts-single-lane §4.4): it never sounds over speech or another
 * notice. Without a shared screen output (a settings preview) the hook keeps its own.
 */
export function useTimerTone(
	settings: {
		outputDevice?: string;
		outputVolume?: number;
		loadTone?: (signal: AbortSignal) => Promise<Uint8Array | undefined>;
		loadCompletion?: (signal: AbortSignal) => Promise<Uint8Array | undefined>;
	} = {},
	sessionAudio?: () => Pick<AudioController, "play" | "stopPlayback"> | null,
	speech?: (text: string, signal: AbortSignal) => Promise<Uint8Array>,
	prepareOnGesture = true,
	sharedOutput?: ScreenOutput,
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
	const [ownOutput] = useState(() => createScreenOutput());
	const screen = sharedOutput ?? ownOutput;
	useEffect(() => () => ownOutput.release(), [ownOutput]);
	const used = useRef<ReturnType<ScreenOutput["controller"]> | null>(null);
	const ensureOutput = useCallback(
		(outputDevice: string) => {
			const entry = screen.controller(outputDevice);
			// A changed device needs a fresh preparation on the next gesture.
			if (used.current && used.current !== entry) setReady(false);
			used.current = entry;
			return entry;
		},
		[screen, setReady],
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
			await screen.start(owned);
			if (used.current === owned) setReady(true);
		} catch (error) {
			if (used.current === owned) setReady(false);
			throw error;
		}
	}, [ensureOutput, screen, setReady]);
	useEffect(() => {
		// Finish the gesture before hiding the preparation card. Preparing on pointerdown
		// can remove a pressed button before its click and send the click to another card.
		if (!prepareOnGesture) return;
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
	}, [prepare, prepareOnGesture]);
	const playTone = useCallback(
		async (
			signal: AbortSignal,
			message?: string,
			onToneDelivered?: () => void,
			completed = false,
			trace?: PlaybackTrace,
			/** Told when the notice lane gives this notice its turn (its own time starts there). */
			onTurn?: () => void,
		) => {
			signal.throwIfAborted();
			const { outputDevice = "", outputVolume = 1 } = latest.current.settings;
			if (outputVolume <= 0) throw new Error("audio_muted");
			// The whole notice (tone, completion voice, message) sounds alone on the screen's output.
			return screen.notice(signal, async () => {
				onTurn?.();
				const session = latest.current.sessionAudio?.();
				const owned = session ? null : ensureOutput(outputDevice);
				const target = session ?? owned!.audio;
				const report: PlaybackTrace = (part, phase) => {
					try {
						trace?.(part, phase);
					} catch {
						// Diagnostic observers cannot interrupt playback or its completion.
					}
				};
				const play = (
					bytes: Uint8Array,
					playbackSignal: AbortSignal = signal,
					part: "tone" | "completion" = "tone",
				) =>
					new Promise<void>((resolve, reject) => {
						let started = false;
						const finish = (error?: Error) => {
							playbackSignal.removeEventListener("abort", abort);
							if (error) reject(error);
							else resolve();
						};
						const abort = () => {
							target.stopPlayback();
							// An output still waiting to start (a gesture) is released; a started one stays shared.
							screen.discardUnstarted(owned);
							finish(new Error("audio_interrupted"));
						};
						playbackSignal.addEventListener("abort", abort, { once: true });
						if (playbackSignal.aborted) {
							abort();
							return;
						}
						void (async () => {
							try {
								if (owned) await screen.start(owned);
								playbackSignal.throwIfAborted();
								await target.play(
									bytes,
									() => {
										report(part, "ended");
										finish();
									},
									{
										volume: Math.min(1, outputVolume),
										suppressInput: true,
										shouldPlay: () => !playbackSignal.aborted,
										onStarted: () => {
											started = true;
											report(part, "started");
										},
										onInterrupted: () => finish(new Error("audio_interrupted")),
									},
								);
								if (!started) finish(new Error("audio_not_started"));
							} catch (error) {
								screen.discardUnstarted(owned);
								finish(
									error instanceof Error ? error : new Error("audio_blocked"),
								);
							}
						})();
					});
				await play(
					(await latest.current.settings.loadTone?.(signal)) ?? timerToneWav(),
				);
				onToneDelivered?.();
				if (completed) {
					const voice = await latest.current.settings.loadCompletion?.(signal);
					signal.throwIfAborted();
					if (voice) await play(voice, signal, "completion");
				}
				// Speech is best effort: an unavailable TTS provider must not erase a delivered beep.
				if (message && latest.current.speech) {
					const speechAbort = new AbortController();
					const abortSpeech = () => speechAbort.abort();
					signal.addEventListener("abort", abortSpeech, { once: true });
					const timeout = setTimeout(abortSpeech, 6000);
					try {
						signal.throwIfAborted();
						const wav = await latest.current.speech(
							message,
							speechAbort.signal,
						);
						await play(wav, speechAbort.signal);
					} catch {
						signal.throwIfAborted();
					} finally {
						clearTimeout(timeout);
						signal.removeEventListener("abort", abortSpeech);
					}
				}
			});
		},
		[ensureOutput, screen],
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
	const playCompletion = useCallback(
		(signal: AbortSignal, trace?: PlaybackTrace) =>
			playTone(signal, undefined, undefined, true, trace),
		[playTone],
	);
	return { play: playTone, playCompletion, repeat, ready, prepare };
}
