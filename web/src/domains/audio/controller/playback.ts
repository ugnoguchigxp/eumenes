import {
	browserTiming,
	timedAudioDecode,
	type TimingIdentity,
} from "../../../performance";
import type { AudioOptions, AudioSession } from "./audio-options";
import type { AudioState } from "./index";
import { createOutputWatch } from "./output-watch";
import { connectPlaybackOutput } from "./playback-output";
const OUTPUT_TAIL_MS = 500;
export function createAudioPlayback(deps: {
	state: AudioSession;
	options: AudioOptions;
	outputWatch: ReturnType<typeof createOutputWatch>;
	emit: (phase: AudioState["phase"], error?: string) => void;
}) {
	const { state, options, outputWatch, emit } = deps;
	let releaseOutput: (() => void) | undefined;
	let playback: AudioBufferSourceNode | undefined;
	let keepAliveSource: AudioBufferSourceNode | undefined;
	let playbackEpoch = 0;
	let playbackDone: Promise<void> = Promise.resolve();
	let finishPlayback: () => void = () => {};
	let interruptedPlayback: (() => void) | undefined;
	let listenAfter = 0;
	let playbackSuppressInput = false;
	let forcedInputGateUntil = 0;

	// Bluetooth outputs sleep on digital silence and clip the start of the next
	// sound while waking. A ~-80 dBFS noise bed (a few 16-bit LSBs) keeps the
	// link open without being audible. Best effort: playback never depends on it.
	function startKeepAlive(ctx: AudioContext) {
		if (keepAliveSource) return;
		if (options.keepAlive === false || typeof ctx.createBuffer !== "function")
			return;
		try {
			const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
			const data = buffer.getChannelData(0);
			for (let i = 0; i < data.length; i++)
				data[i] = (Math.random() * 2 - 1) * 1e-4;
			const bed = ctx.createBufferSource();
			bed.buffer = buffer;
			bed.loop = true;
			bed.connect(ctx.destination);
			bed.start();
			keepAliveSource = bed;
		} catch {
			keepAliveSource = undefined;
		}
	}
	return {
		get playing() {
			return !!playback;
		},
		get listenAfter() {
			return listenAfter;
		},
		get suppressInput() {
			return playbackSuppressInput;
		},
		get forcedGateUntil() {
			return forcedInputGateUntil;
		},
		startKeepAlive,
		stopKeepAlive() {
			try {
				keepAliveSource?.stop();
			} catch {
				// Already stopped together with its context.
			}
			keepAliveSource?.disconnect();
			keepAliveSource = undefined;
		},
		async startOutput() {
			if (state.disposed) return;
			if (state.context) {
				// A previous resume can still be waiting for a browser user gesture.
				await state.context.resume();
				return;
			}
			const startedContext = new AudioContext();
			state.context = startedContext;
			try {
				if (options.outputDevice && "setSinkId" in startedContext)
					await (
						startedContext as AudioContext & {
							setSinkId: (id: string) => Promise<void>;
						}
					).setSinkId(options.outputDevice);
				if (state.disposed || state.context !== startedContext) return;
				await startedContext.resume();
				if (state.disposed || state.context !== startedContext) return;
				outputWatch.watch(startedContext);
			} catch (error) {
				// A half-started output must not stay cached as if it worked.
				state.context = undefined;
				void startedContext.close().catch(() => {});
				throw error;
			}
		},
		async play(
			bytes: Uint8Array,
			onEnded: () => void,
			playOptions: {
				/** Only assistant speech drives the avatar; notices and tones leave this off. */
				assistantSpeech?: boolean;
				waitForPrevious?: boolean;
				shouldPlay?: () => boolean;
				volume?: number;
				onStarted?: () => void;
				timing?: TimingIdentity;
				/** Alarm tones never become microphone input, including their output tail. */
				suppressInput?: boolean;
				/** Called when this playback is cut off by another one or by stopPlayback(). */
				onInterrupted?: () => void;
			} = {},
		) {
			const waitingEpoch = playbackEpoch;
			if (!state.context || state.disposed)
				throw new Error("audio_not_started");
			// Decoded while the previous one still plays, so the next starts right at its end.
			const buffer = await timedAudioDecode(
				state.context,
				bytes,
				playOptions.timing,
			);
			if (playOptions.waitForPrevious && playback) await playbackDone;
			if (
				state.disposed ||
				!state.context ||
				waitingEpoch !== playbackEpoch ||
				playOptions.shouldPlay?.() === false
			)
				return;
			this.stopPlayback();
			const next = state.context.createBufferSource();
			next.buffer = buffer;
			const volume = playOptions.volume ?? 1;
			releaseOutput = connectPlaybackOutput(
				state.context,
				next,
				volume,
				playOptions.assistantSpeech ?? false,
			);
			playback = next;
			playbackSuppressInput = playOptions.suppressInput ?? false;
			interruptedPlayback = playOptions.onInterrupted;
			playbackDone = new Promise<void>((resolve) => {
				finishPlayback = resolve;
			});
			next.onended = () => {
				if (playback === next) {
					interruptedPlayback = undefined;
					releaseOutput?.();
					releaseOutput = undefined;
					listenAfter = performance.now() + OUTPUT_TAIL_MS;
					if (playbackSuppressInput) forcedInputGateUntil = listenAfter;
					playbackSuppressInput = false;
					playback = undefined;
					finishPlayback();
					emit("listening");
					onEnded();
				}
			};
			next.start();
			browserTiming("playback_scheduled", playOptions.timing ?? {});
			playOptions.onStarted?.();
			emit("playing");
		},
		stopPlayback() {
			releaseOutput?.();
			releaseOutput = undefined;
			playbackEpoch++;
			finishPlayback();
			if (playbackSuppressInput)
				forcedInputGateUntil = performance.now() + OUTPUT_TAIL_MS;
			playbackSuppressInput = false;
			const old = playback;
			const interrupted = interruptedPlayback;
			interruptedPlayback = undefined;
			playback = undefined;
			if (old) {
				old.onended = null;
				old.stop();
				interrupted?.();
			}
			emit(state.context ? "listening" : "idle");
		},
	};
}
