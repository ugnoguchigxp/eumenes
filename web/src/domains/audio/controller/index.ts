import type { AudioOptions, AudioSession, LostReason } from "./audio-options";
import { createOutputWatch } from "./output-watch";
import { createAudioPlayback } from "./playback";
import { traceAudioOutput } from "./playback-trace";
import {
	openMicrophone,
	openRecorderNode,
	watchInputDevices,
} from "./recording-input";
import { createResampler } from "./resample";
import { createSegmentClock, type SegmentTiming } from "./segment-timing";
import {
	createSpeechClassifier,
	type SpeechClassifier,
} from "./speech-classifier";
import {
	DEFAULT_VOICE_SILENCE_TIMEOUT_MS,
	SpeechDetector,
} from "./speech-detector";
export type AudioState = {
	phase: "idle" | "listening" | "playing" | "error";
	/** Capture readiness is independent of output playback. */
	inputPhase?: "idle" | "starting" | "ready";
	error?: string;
	level: number;
};
function wav(samples: Float32Array, rate: number): Uint8Array {
	const bytes = new Uint8Array(44 + samples.length * 2);
	const view = new DataView(bytes.buffer);
	const tag = (offset: number, text: string) => {
		for (let i = 0; i < text.length; i++)
			view.setUint8(offset + i, text.charCodeAt(i));
	};
	tag(0, "RIFF");
	view.setUint32(4, bytes.length - 8, true);
	tag(8, "WAVE");
	tag(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, rate, true);
	view.setUint32(28, rate * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	tag(36, "data");
	view.setUint32(40, samples.length * 2, true);
	for (let i = 0; i < samples.length; i++)
		view.setInt16(
			44 + i * 2,
			Math.max(-1, Math.min(1, samples[i] ?? 0)) * 32767,
			true,
		);
	return bytes;
}
/** Appends frames resampled to 16 kHz; partial results only filter the window still open. */
export function createIncrementalEncoder(rate: number) {
	const resampler = createResampler(rate);
	let out = new Float32Array(16_384);
	let outLength = 0;
	return {
		push(frame: Float32Array) {
			const next = resampler.push(frame);
			if (outLength + next.length > out.length) {
				const grown = new Float32Array(
					Math.max(out.length * 2, outLength + next.length),
				);
				grown.set(out.subarray(0, outLength));
				out = grown;
			}
			out.set(next, outLength);
			outLength += next.length;
		},
		wav(): Uint8Array {
			const tail = resampler.tail();
			const samples = new Float32Array(outLength + tail.length);
			samples.set(out.subarray(0, outLength));
			samples.set(tail, outLength);
			return wav(samples, resampler.rate);
		},
	};
}
type IncrementalEncoder = ReturnType<typeof createIncrementalEncoder>;
/**
 * Seconds between partial results grows with the utterance so total work stays near-linear. The first
 * comes 1.8 s after confirmation (not counting the pre-roll), so a short reply ends before any preview,
 * and none is sent in the trailing silence: the final upload follows and would cancel it.
 */
export const partialInterval = (seconds: number) =>
	Math.min(2, 0.6 + 0.1 * seconds);

/** Samples per frame handed to the voice detector. */

// 16 kHz PCM stays below the API's 4 MB limit without splitting a question.
const MAX_RECORDING_SECONDS = 60;
/** Audio kept before speech is confirmed: confirmation lags the onset by the voiced span needed. */
const PRE_ROLL_SECONDS = 1;
/**
 * Closes a model load, whatever its outcome (stop, or a worker that failed: the next start loads a
 * new one), and leaves nothing to reuse.
 */
const release = (load: Promise<SpeechClassifier> | undefined) => {
	void load?.then(
		(model) => model.close(),
		() => {},
	);
	return undefined;
};
/** Output-to-ear latency allowance after playback ends (Bluetooth can add ~300 ms). */

export function createAudioController(
	onState: (state: AudioState) => void,
	onSpeech: () => void,
	onSegment: (wav: Uint8Array, timing?: SegmentTiming) => void,
	options: AudioOptions = {},
) {
	const state: AudioSession = { context: undefined, disposed: false };
	let stream: MediaStream | undefined;
	let worklet: AudioWorkletNode | undefined;
	let drainRecorder: (() => void) | undefined;
	let source: MediaStreamAudioSourceNode | undefined;

	let inputPaused = true;
	let inputReady = false;
	let inputEpoch = 0;
	let speaking = false;
	let detector: SpeechDetector | undefined;
	/** Loaded once (one load shared by overlapping starts) and kept across pauses; released by stop(). */
	let classifier: Promise<SpeechClassifier> | undefined;
	let candidateFrames: Float32Array[] = [];
	let candidateSamples = 0;
	let encoder: IncrementalEncoder | undefined;
	let lastFrame: Float32Array | undefined;
	let sampleCount = 0;
	let lastLevel = 0;
	const clock = createSegmentClock();
	let nextPartialAt = 0;
	let lastEmit = 0;
	let wasGated = false;
	let releaseWatchers: () => void = () => {};
	let lostReported = false;
	const reportLost = (reason: LostReason) => {
		if (state.disposed || lostReported) return;
		lostReported = true;
		options.onLost?.(reason);
	};
	const outputWatch = createOutputWatch({
		outputDevice: options.outputDevice,
		isCurrent: (ctx) => !state.disposed && state.context === ctx,
		onLost: () => reportLost("audio_output_lost"),
	});
	const emit = (phase: AudioState["phase"], error?: string) =>
		onState({
			phase: phase === "listening" && !stream ? "idle" : phase,
			inputPhase: inputPaused ? "idle" : inputReady ? "ready" : "starting",
			error,
			level: lastLevel,
		});

	const output = createAudioPlayback({ state, options, outputWatch, emit });

	function pushFrame(frame: Float32Array) {
		encoder ??= createIncrementalEncoder(state.context!.sampleRate);
		encoder.push(frame);
		lastFrame = frame;
		sampleCount += frame.length;
	}
	function resetRecording() {
		encoder = undefined;
		lastFrame = undefined;
		sampleCount = 0;
	}
	function encodeFrames(): Uint8Array {
		encoder ??= createIncrementalEncoder(state.context!.sampleRate);
		return encoder.wav();
	}
	function flush() {
		const segment =
			state.context && sampleCount >= state.context.sampleRate * 0.25
				? clock.take(sampleCount, state.context.sampleRate, encodeFrames)
				: undefined;
		resetRecording();
		nextPartialAt = 0;
		// A consumer may pause capture synchronously when its upload queue fills.
		if (segment) onSegment(segment.wav, segment.timing);
	}
	function pauseInput() {
		// Include samples received since the last complete detector frame.
		const drain = drainRecorder;
		drainRecorder = undefined;
		drain?.();
		const shouldFlush = speaking;
		speaking = false;
		inputPaused = true;
		inputReady = false;
		inputEpoch++;
		releaseWatchers();
		if (worklet) worklet.port.onmessage = null;
		worklet?.disconnect();
		source?.disconnect();
		stream?.getTracks().forEach((track) => track.stop());
		stream = undefined;
		worklet = undefined;
		source = undefined;
		detector = undefined;
		if (shouldFlush) flush();
		resetRecording();
		candidateFrames = [];
		candidateSamples = 0;
		lastLevel = 0;
		emit(output.playing ? "playing" : "idle");
	}

	return traceAudioOutput({
		async start() {
			if (state.disposed || stream) return;
			inputPaused = false;
			inputReady = false;
			emit(output.playing ? "playing" : "idle");
			lostReported = false;
			const recordingEpoch = ++inputEpoch;
			try {
				const opened = await openMicrophone(options);
				if (state.disposed || inputPaused || recordingEpoch !== inputEpoch) {
					opened.getTracks().forEach((t) => {
						t.stop();
					});
					return;
				}
				stream = opened;
				const startedContext = state.context ?? new AudioContext();
				state.context = startedContext;
				if (options.outputDevice && "setSinkId" in startedContext)
					await (
						startedContext as AudioContext & {
							setSinkId: (id: string) => Promise<void>;
						}
					).setSinkId(options.outputDevice);
				if (
					state.disposed ||
					inputPaused ||
					recordingEpoch !== inputEpoch ||
					state.context !== startedContext
				)
					return;
				await startedContext.resume();
				if (
					state.disposed ||
					inputPaused ||
					recordingEpoch !== inputEpoch ||
					state.context !== startedContext
				)
					return;
				outputWatch.watch(startedContext);
				output.startKeepAlive(startedContext);
				const loading = (classifier ??= createSpeechClassifier());
				// A failed load is not kept: the next start tries again.
				const model = await loading.catch((error: unknown) => {
					if (classifier === loading) classifier = undefined;
					throw error;
				});
				// stop() during the load released nothing yet; this start owns the release.
				if (state.disposed) return model.close();
				if (
					inputPaused ||
					recordingEpoch !== inputEpoch ||
					state.context !== startedContext
				)
					return;
				model.reset();
				releaseWatchers = watchInputDevices(
					startedContext,
					stream,
					(ctx) => !state.disposed && state.context === ctx,
					reportLost,
				);
				detector = new SpeechDetector({
					sampleRate: state.context.sampleRate,
					classifier: model,
					silenceTimeoutMs:
						options.silenceMs ?? DEFAULT_VOICE_SILENCE_TIMEOUT_MS,
					minimumRms: options.threshold ?? 0.008,
				});
				source = state.context.createMediaStreamSource(stream);
				const handleFrame = (frame: Float32Array) => {
					if (
						state.disposed ||
						inputPaused ||
						recordingEpoch !== inputEpoch ||
						!state.context
					)
						return;
					const gated =
						(!!options.halfDuplex?.() &&
							(!!output.playing || performance.now() < output.listenAfter)) ||
						(!!output.playing && output.suppressInput) ||
						performance.now() < output.forcedGateUntil;
					if (gated) {
						// Drop anything heard so far; the reply must not become input.
						frame.fill(0);
						if (!wasGated) {
							speaking = false;
							resetRecording();
							candidateFrames = [];
							candidateSamples = 0;
							detector?.restart();
						}
					}
					wasGated = gated;
					// Our own reply (and its output tail) may reach the microphone while barge-in is on.
					const observation = detector?.observe(frame, {
						strict: !!output.playing || performance.now() < output.listenAfter,
					});
					if (detector?.failed) {
						classifier = release(classifier);
						reportLost("voice_detector_unavailable");
						return;
					}
					lastLevel = observation?.rms ?? 0;
					if (!speaking) {
						candidateFrames.push(frame);
						candidateSamples += frame.length;
						while (
							candidateSamples > state.context.sampleRate * PRE_ROLL_SECONDS &&
							candidateFrames.length > 1
						) {
							candidateSamples -= candidateFrames.shift()?.length ?? 0;
						}
						if (observation?.hasSpeech) {
							speaking = true;
							resetRecording();
							for (const candidate of candidateFrames) pushFrame(candidate);
							clock.confirmed(sampleCount);
							nextPartialAt = sampleCount + state.context.sampleRate * 1.8;
							candidateFrames = [];
							candidateSamples = 0;
							onSpeech();
						}
					}
					if (speaking) {
						if (!observation?.hasSpeech || lastFrame !== frame)
							pushFrame(frame);
						if (detector?.hearing) clock.heard(sampleCount);
						if (
							options.onPartial &&
							!observation?.shouldFinalize &&
							detector?.hearing &&
							sampleCount >= nextPartialAt
						) {
							nextPartialAt =
								sampleCount +
								state.context.sampleRate *
									partialInterval(sampleCount / state.context.sampleRate);
							options.onPartial(encodeFrames());
						}
						if (
							sampleCount >=
							state.context.sampleRate * MAX_RECORDING_SECONDS
						) {
							pauseInput();
							options.onNotice?.("recording_limit");
							return;
						}
						if (observation?.shouldFinalize) {
							speaking = false;
							detector?.restart();
							flush();
						}
					}
					if (!inputReady || performance.now() - lastEmit > 200) {
						inputReady = true;
						lastEmit = performance.now();
						emit(output.playing ? "playing" : "listening");
					}
				};
				const recorder = await openRecorderNode(
					state.context,
					handleFrame,
					() => reportLost("mic_lost"),
				);
				if (
					state.disposed ||
					inputPaused ||
					recordingEpoch !== inputEpoch ||
					state.context !== startedContext
				) {
					recorder.node.disconnect();
					recorder.node.port.onmessage = null;
					return;
				}
				worklet = recorder.node;
				drainRecorder = recorder.drain;
				source.connect(worklet);
				worklet.connect(state.context.destination);
				emit("listening");
			} catch (error) {
				if (state.disposed || recordingEpoch !== inputEpoch) return;
				pauseInput();
				emit(
					"error",
					error instanceof Error ? error.message : "microphone_unavailable",
				);
				throw error;
			}
		},
		/** Read at notice dispatch time; silence while waiting for speech is not busy. */
		isInputBusy: () => speaking,
		/** Output only (no microphone): used to read text aloud outside a voice session. */
		startOutput: output.startOutput,
		play: output.play,
		stopPlayback: output.stopPlayback,
		async stop() {
			state.disposed = true;
			inputPaused = true;
			inputReady = false;
			drainRecorder = undefined;
			lastLevel = 0;
			releaseWatchers();
			outputWatch.release();
			this.stopPlayback();
			output.stopKeepAlive();
			if (worklet) worklet.port.onmessage = null;
			worklet?.disconnect();
			worklet = undefined;
			source?.disconnect();
			stream?.getTracks().forEach((t) => {
				t.stop();
			});
			await state.context?.close();
			source = undefined;
			stream = undefined;
			state.context = undefined;
			resetRecording();
			candidateFrames = [];
			candidateSamples = 0;
			detector = undefined;
			classifier = release(classifier);
			emit("idle");
		},
		/** Stop recording while keeping the accepted answer's output context alive. */
		pauseInput,
	});
}
type Controller = ReturnType<typeof createAudioController>;
export type AudioController = Pick<
	Controller,
	"start" | "stop" | "stopPlayback" | "play"
> &
	Partial<Pick<Controller, "isInputBusy" | "pauseInput">>;
/** Playback-only subset used for read-aloud outside a voice session. */
export type OutputController = Pick<
	Controller,
	"startOutput" | "stop" | "stopPlayback" | "play"
>;
export type CreateAudio = (
	...args: Parameters<typeof createAudioController>
) => AudioController;
