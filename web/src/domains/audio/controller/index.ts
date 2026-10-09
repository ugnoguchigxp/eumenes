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
import recorderWorkletUrl from "../worklet/recorder.worklet.ts?worker&url";

/** Samples per frame handed to the voice detector (same as the old ScriptProcessor size). */
const FRAME_SAMPLES = 2048;

/**
 * Captures microphone frames with an AudioWorklet (off the main thread), falling
 * back to the deprecated ScriptProcessorNode where the worklet cannot load.
 */
async function openRecorderNode(
	ctx: AudioContext,
	onFrame: (frame: Float32Array) => void,
	onFailure: () => void,
): Promise<
	| { kind: "worklet"; node: AudioWorkletNode }
	| { kind: "script"; node: ScriptProcessorNode }
> {
	if (typeof ctx.audioWorklet?.addModule === "function") {
		try {
			await ctx.audioWorklet.addModule(recorderWorkletUrl);
			const node = new AudioWorkletNode(ctx, "eumenes-recorder", {
				numberOfInputs: 1,
				numberOfOutputs: 1,
				channelCount: 1,
			});
			let pending: Float32Array[] = [];
			let pendingSamples = 0;
			node.port.onmessage = (event: MessageEvent<Float32Array>) => {
				pending.push(event.data);
				pendingSamples += event.data.length;
				if (pendingSamples < FRAME_SAMPLES) return;
				const frame = new Float32Array(pendingSamples);
				let offset = 0;
				for (const part of pending) {
					frame.set(part, offset);
					offset += part.length;
				}
				pending = [];
				pendingSamples = 0;
				onFrame(frame);
			};
			node.onprocessorerror = () => onFailure();
			return { kind: "worklet", node };
		} catch {
			// Fall through to the main-thread processor.
		}
	}
	const node = ctx.createScriptProcessor(FRAME_SAMPLES, 1, 1);
	node.onaudioprocess = (event) =>
		onFrame(new Float32Array(event.inputBuffer.getChannelData(0)));
	return { kind: "script", node };
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
		/** The microphone or audio output went away; the session cannot continue. */
		onLost?: (reason: "mic_lost" | "audio_context_lost") => void;
		/** The saved input device was missing and the default one is used instead. */
		onNotice?: (reason: "saved_device_missing") => void;
	} = {},
) {
	let context: AudioContext | undefined;
	let stream: MediaStream | undefined;
	let processor: ScriptProcessorNode | undefined;
	let worklet: AudioWorkletNode | undefined;
	let source: MediaStreamAudioSourceNode | undefined;
	let playback: AudioBufferSourceNode | undefined;
	let playbackGain: GainNode | undefined;
	let keepAliveSource: AudioBufferSourceNode | undefined;
	let playbackEpoch = 0;
	let playbackDone: Promise<void> = Promise.resolve();
	let finishPlayback: () => void = () => {};
	let interruptedPlayback: (() => void) | undefined;
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
	let releaseWatchers: () => void = () => {};
	let lostReported = false;
	const reportLost = (reason: "mic_lost" | "audio_context_lost") => {
		if (disposed || lostReported) return;
		lostReported = true;
		options.onLost?.(reason);
	};
	const audioConstraints = (withDevice: boolean) => ({
		audio: {
			deviceId:
				withDevice && options.inputDevice
					? { exact: options.inputDevice }
					: undefined,
			echoCancellation: options.echoCancellation ?? true,
			noiseSuppression: options.noiseSuppression ?? true,
			autoGainControl: options.autoGainControl ?? true,
		},
	});
	async function openMicrophone(): Promise<MediaStream> {
		try {
			return await navigator.mediaDevices.getUserMedia(audioConstraints(true));
		} catch (error) {
			const name = error instanceof Error ? error.name : "";
			// A saved device that is no longer present must not silently block voice.
			if (
				!options.inputDevice ||
				(name !== "OverconstrainedError" && name !== "NotFoundError")
			)
				throw error;
			const fallback = await navigator.mediaDevices.getUserMedia(
				audioConstraints(false),
			);
			options.onNotice?.("saved_device_missing");
			return fallback;
		}
	}
	/** Watches for the microphone, device list or AudioContext disappearing. */
	function watchDevices(ctx: AudioContext, input: MediaStream) {
		const cleanups: Array<() => void> = [];
		const tracks = input.getAudioTracks?.() ?? [];
		for (const track of tracks) {
			const ended = () => reportLost("mic_lost");
			track.addEventListener?.("ended", ended);
			cleanups.push(() => track.removeEventListener?.("ended", ended));
		}
		const devices = navigator.mediaDevices;
		const currentId = tracks[0]?.getSettings?.().deviceId;
		if (devices?.addEventListener && devices.enumerateDevices && currentId) {
			const changed = () => {
				void devices
					.enumerateDevices()
					.then((list) => {
						if (
							!list.some(
								(d) => d.kind === "audioinput" && d.deviceId === currentId,
							)
						)
							reportLost("mic_lost");
					})
					.catch(() => {});
			};
			devices.addEventListener("devicechange", changed);
			cleanups.push(() => devices.removeEventListener("devicechange", changed));
		}
		if (typeof ctx.addEventListener === "function") {
			let resumed = false;
			const changed = () => {
				if (disposed || context !== ctx) return;
				if (
					ctx.state !== "suspended" &&
					ctx.state !== ("interrupted" as string)
				)
					return;
				if (resumed) return reportLost("audio_context_lost");
				resumed = true;
				ctx.resume().then(
					() => {
						if (ctx.state === "running") resumed = false;
					},
					() => reportLost("audio_context_lost"),
				);
			};
			ctx.addEventListener("statechange", changed);
			cleanups.push(() => ctx.removeEventListener("statechange", changed));
		}
		releaseWatchers = () => {
			for (const cleanup of cleanups.splice(0)) cleanup();
			releaseWatchers = () => {};
		};
	}
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
				stream = await openMicrophone();
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
				watchDevices(startedContext, stream);
				detector = new VoiceActivityDetector({
					sampleRate: context.sampleRate,
					silenceTimeoutMs: options.silenceMs ?? 700,
					speechThresholdRms: options.threshold ?? 0.008,
				});
				source = context.createMediaStreamSource(stream);
				const handleFrame = (frame: Float32Array) => {
					if (disposed || !context) return;
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
				const recorder = await openRecorderNode(context, handleFrame, () =>
					reportLost("mic_lost"),
				);
				if (disposed || context !== startedContext) return;
				if (recorder.kind === "worklet") worklet = recorder.node;
				else processor = recorder.node;
				const input = worklet ?? processor;
				if (!input) return;
				source.connect(input);
				input.connect(context.destination);
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
		/** Output only (no microphone): used to read text aloud outside a voice session. */
		async startOutput() {
			if (disposed || context) return;
			const startedContext = new AudioContext();
			context = startedContext;
			try {
				if (options.outputDevice && "setSinkId" in startedContext)
					await (
						startedContext as AudioContext & {
							setSinkId: (id: string) => Promise<void>;
						}
					).setSinkId(options.outputDevice);
				if (disposed || context !== startedContext) return;
				await startedContext.resume();
			} catch (error) {
				// A half-started output must not stay cached as if it worked.
				context = undefined;
				void startedContext.close().catch(() => {});
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
				/** Called when this playback is cut off by another one or by stopPlayback(). */
				onInterrupted?: () => void;
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
			interruptedPlayback = playOptions.onInterrupted;
			playbackDone = new Promise<void>((resolve) => {
				finishPlayback = resolve;
			});
			next.onended = () => {
				if (playback === next) {
					interruptedPlayback = undefined;
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
			const interrupted = interruptedPlayback;
			interruptedPlayback = undefined;
			playback = undefined;
			playbackGain?.disconnect();
			playbackGain = undefined;
			if (old) {
				old.onended = null;
				old.stop();
				interrupted?.();
			}
			emit(context ? "listening" : "idle");
		},
		async stop() {
			disposed = true;
			lastLevel = 0;
			releaseWatchers();
			this.stopPlayback();
			try {
				keepAliveSource?.stop();
			} catch {
				// Already stopped together with its context.
			}
			keepAliveSource?.disconnect();
			keepAliveSource = undefined;
			processor?.disconnect();
			if (worklet) worklet.port.onmessage = null;
			worklet?.disconnect();
			worklet = undefined;
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
type Controller = ReturnType<typeof createAudioController>;
export type AudioController = Pick<
	Controller,
	"start" | "stop" | "stopPlayback" | "play"
>;
/** Playback-only subset used for read-aloud outside a voice session. */
export type OutputController = Pick<
	Controller,
	"startOutput" | "stop" | "stopPlayback" | "play"
>;
export type CreateAudio = (
	...args: Parameters<typeof createAudioController>
) => AudioController;
import { VoiceActivityDetector } from "./voice-activity";
