export type AudioState = {
	phase: "idle" | "listening" | "playing" | "error";
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
/** Output-to-ear latency allowance after playback ends (Bluetooth can add ~300 ms). */
const OUTPUT_TAIL_MS = 500;
export function createAudioController(
	onState: (state: AudioState) => void,
	onSpeech: () => void,
	onSegment: (wav: Uint8Array) => void,
	options: {
		inputDevice?: string;
		outputDevice?: string;
		threshold?: number;
		silenceMs?: number;
		echoCancellation?: boolean;
		noiseSuppression?: boolean;
		autoGainControl?: boolean;
		onPartial?: (wav: Uint8Array) => void;
		/**
		 * Half duplex: while our own speech plays (and briefly after, for output
		 * latency such as Bluetooth) the microphone is treated as silent, so the
		 * reply is never recognized as the next utterance. Evaluated per frame.
		 */
		halfDuplex?: () => boolean;
		/** Keep the output device awake with an inaudible bed (default on). */
		keepAlive?: boolean;
	} = {},
) {
	let context: AudioContext | undefined;
	let stream: MediaStream | undefined;
	let processor: ScriptProcessorNode | undefined;
	let source: MediaStreamAudioSourceNode | undefined;
	let playback: AudioBufferSourceNode | undefined;
	let playbackGain: GainNode | undefined;
	let keepAliveSource: AudioBufferSourceNode | undefined;
	let playbackEpoch = 0;
	let playbackDone: Promise<void> = Promise.resolve();
	let finishPlayback: () => void = () => {};
	let disposed = false;
	let speaking = false;
	let detector: VoiceActivityDetector | undefined;
	let candidateFrames: Float32Array[] = [];
	let candidateSamples = 0;
	let frames: Float32Array[] = [];
	let sampleCount = 0;
	let lastLevel = 0;
	let nextPartialAt = 0;
	let lastEmit = 0;
	let listenAfter = 0;
	let wasGated = false;
	const emit = (phase: AudioState["phase"], error?: string) =>
		onState({ phase, error, level: lastLevel });

	// Bluetooth outputs sleep on digital silence and clip the start of the next
	// sound while waking. A ~-80 dBFS noise bed (a few 16-bit LSBs) keeps the
	// link open without being audible. Best effort: playback never depends on it.
	function startKeepAlive(ctx: AudioContext) {
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

	function encodeFrames(): Uint8Array {
		const joined = new Float32Array(sampleCount);
		let offset = 0;
		for (const frame of frames) {
			joined.set(frame, offset);
			offset += frame.length;
		}
		const rate = context!.sampleRate;
		if (rate <= 16000) return wav(joined, rate);
		const ratio = rate / 16000;
		const downsampled = new Float32Array(Math.floor(joined.length / ratio));
		for (let i = 0; i < downsampled.length; i++) {
			const begin = Math.floor(i * ratio),
				end = Math.floor((i + 1) * ratio);
			let sum = 0;
			for (let n = begin; n < end; n++) sum += joined[n] ?? 0;
			downsampled[i] = sum / Math.max(1, end - begin);
		}
		return wav(downsampled, 16000);
	}
	function flush() {
		if (context && sampleCount >= context.sampleRate * 0.25)
			onSegment(encodeFrames());
		frames = [];
		sampleCount = 0;
		nextPartialAt = 0;
	}

	return {
		async start() {
			if (disposed || context) return;
			try {
				stream = await navigator.mediaDevices.getUserMedia({
					audio: {
						deviceId: options.inputDevice
							? { exact: options.inputDevice }
							: undefined,
						echoCancellation: options.echoCancellation ?? true,
						noiseSuppression: options.noiseSuppression ?? true,
						autoGainControl: options.autoGainControl ?? true,
					},
				});
				if (disposed) {
					stream.getTracks().forEach((t) => {
						t.stop();
					});
					return;
				}
				const startedContext = new AudioContext();
				context = startedContext;
				if (options.outputDevice && "setSinkId" in startedContext)
					await (
						startedContext as AudioContext & {
							setSinkId: (id: string) => Promise<void>;
						}
					).setSinkId(options.outputDevice);
				if (disposed || context !== startedContext) return;
				await startedContext.resume();
				if (disposed || context !== startedContext) return;
				startKeepAlive(startedContext);
				detector = new VoiceActivityDetector({
					sampleRate: context.sampleRate,
					silenceTimeoutMs: options.silenceMs ?? 700,
					speechThresholdRms: options.threshold ?? 0.008,
				});
				source = context.createMediaStreamSource(stream);
				processor = context.createScriptProcessor(2048, 1, 1);
				processor.onaudioprocess = (event) => {
					if (disposed || !context) return;
					const data = event.inputBuffer.getChannelData(0);
					const frame = new Float32Array(data);
					const gated =
						!!options.halfDuplex?.() &&
						(!!playback || performance.now() < listenAfter);
					if (gated) {
						// Drop anything heard so far; the reply must not become input.
						frame.fill(0);
						if (!wasGated) {
							speaking = false;
							frames = [];
							sampleCount = 0;
							candidateFrames = [];
							candidateSamples = 0;
							detector = new VoiceActivityDetector({
								sampleRate: context.sampleRate,
								silenceTimeoutMs: options.silenceMs ?? 700,
								speechThresholdRms: options.threshold ?? 0.008,
							});
						}
					}
					wasGated = gated;
					const observation = detector?.observe(frame);
					lastLevel = observation?.rms ?? 0;
					if (!speaking) {
						candidateFrames.push(frame);
						candidateSamples += frame.length;
						while (
							candidateSamples > context.sampleRate * 0.5 &&
							candidateFrames.length > 1
						) {
							candidateSamples -= candidateFrames.shift()?.length ?? 0;
						}
						if (observation?.hasSpeech) {
							speaking = true;
							nextPartialAt = context.sampleRate * 1.8;
							frames = candidateFrames;
							sampleCount = candidateSamples;
							candidateFrames = [];
							candidateSamples = 0;
							onSpeech();
						}
					}
					if (speaking) {
						if (!observation?.hasSpeech || frames.at(-1) !== frame) {
							frames.push(frame);
							sampleCount += frame.length;
						}
						if (
							options.onPartial &&
							!observation?.shouldFinalize &&
							sampleCount >= nextPartialAt
						) {
							nextPartialAt = sampleCount + context.sampleRate * 0.6;
							options.onPartial(encodeFrames());
						}
						if (
							observation?.shouldFinalize ||
							sampleCount > context.sampleRate * 10
						) {
							speaking = false;
							detector = new VoiceActivityDetector({
								sampleRate: context.sampleRate,
								silenceTimeoutMs: options.silenceMs ?? 700,
								speechThresholdRms: options.threshold ?? 0.008,
							});
							flush();
						}
					}
					if (performance.now() - lastEmit > 200) {
						lastEmit = performance.now();
						emit(playback ? "playing" : "listening");
					}
				};
				source.connect(processor);
				processor.connect(context.destination);
				emit("listening");
			} catch (error) {
				if (disposed) return;
				emit(
					"error",
					error instanceof Error ? error.message : "microphone_unavailable",
				);
				throw error;
			}
		},
		async play(
			bytes: Uint8Array,
			onEnded: () => void,
			playOptions: {
				waitForPrevious?: boolean;
				shouldPlay?: () => boolean;
				volume?: number;
				onStarted?: () => void;
			} = {},
		) {
			const waitingEpoch = playbackEpoch;
			if (playOptions.waitForPrevious && playback) await playbackDone;
			if (
				disposed ||
				waitingEpoch !== playbackEpoch ||
				playOptions.shouldPlay?.() === false
			)
				return;
			if (!context || disposed) throw new Error("audio_not_started");
			this.stopPlayback();
			const epoch = playbackEpoch;
			const buffer = await context.decodeAudioData(
				new Uint8Array(bytes).buffer,
			);
			if (
				disposed ||
				epoch !== playbackEpoch ||
				playOptions.shouldPlay?.() === false
			)
				return;
			const next = context.createBufferSource();
			next.buffer = buffer;
			const volume = playOptions.volume ?? 1;
			if (!Number.isFinite(volume) || volume < 0 || volume > 1)
				throw new Error("audio_volume_invalid");
			if (volume !== 1) {
				playbackGain = context.createGain();
				playbackGain.gain.value = volume;
				next.connect(playbackGain);
				playbackGain.connect(context.destination);
			} else next.connect(context.destination);
			playback = next;
			playbackDone = new Promise<void>((resolve) => {
				finishPlayback = resolve;
			});
			next.onended = () => {
				if (playback === next) {
					listenAfter = performance.now() + OUTPUT_TAIL_MS;
					playback = undefined;
					playbackGain?.disconnect();
					playbackGain = undefined;
					finishPlayback();
					emit("listening");
					onEnded();
				}
			};
			next.start();
			playOptions.onStarted?.();
			emit("playing");
		},
		stopPlayback() {
			playbackEpoch++;
			finishPlayback();
			const old = playback;
			playback = undefined;
			playbackGain?.disconnect();
			playbackGain = undefined;
			if (old) {
				old.onended = null;
				old.stop();
			}
			emit(context ? "listening" : "idle");
		},
		async stop() {
			disposed = true;
			lastLevel = 0;
			this.stopPlayback();
			try {
				keepAliveSource?.stop();
			} catch {
				// Already stopped together with its context.
			}
			keepAliveSource?.disconnect();
			keepAliveSource = undefined;
			processor?.disconnect();
			source?.disconnect();
			stream?.getTracks().forEach((t) => {
				t.stop();
			});
			await context?.close();
			processor = undefined;
			source = undefined;
			stream = undefined;
			context = undefined;
			frames = [];
			sampleCount = 0;
			candidateFrames = [];
			candidateSamples = 0;
			detector = undefined;
			emit("idle");
		},
	};
}
export type AudioController = ReturnType<typeof createAudioController>;
import { VoiceActivityDetector } from "./voice-activity";
