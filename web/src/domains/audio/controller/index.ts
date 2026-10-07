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
export function createAudioController(
	onState: (state: AudioState) => void,
	onSpeech: () => void,
	onSegment: (wav: Uint8Array) => void,
) {
	let context: AudioContext | undefined;
	let stream: MediaStream | undefined;
	let processor: ScriptProcessorNode | undefined;
	let source: MediaStreamAudioSourceNode | undefined;
	let playback: AudioBufferSourceNode | undefined;
	let playbackEpoch = 0;
	let disposed = false;
	let speaking = false;
	let detector: VoiceActivityDetector | undefined;
	let candidateFrames: Float32Array[] = [];
	let candidateSamples = 0;
	let frames: Float32Array[] = [];
	let sampleCount = 0;
	let lastLevel = 0;
	let lastEmit = 0;
	const emit = (phase: AudioState["phase"], error?: string) =>
		onState({ phase, error, level: lastLevel });
	function flush() {
		if (!context || sampleCount < context.sampleRate * 0.25) {
			frames = [];
			sampleCount = 0;
			return;
		}
		const joined = new Float32Array(sampleCount);
		let offset = 0;
		for (const frame of frames) {
			joined.set(frame, offset);
			offset += frame.length;
		}
		frames = [];
		sampleCount = 0;
		onSegment(wav(joined, context.sampleRate));
	}
	return {
		async start() {
			if (disposed || context) return;
			try {
				stream = await navigator.mediaDevices.getUserMedia({
					audio: {
						echoCancellation: true,
						noiseSuppression: true,
						autoGainControl: true,
					},
				});
				if (disposed) {
					stream.getTracks().forEach((t) => {
						t.stop();
					});
					return;
				}
				context = new AudioContext();
				await context.resume();
				detector = new VoiceActivityDetector({
					sampleRate: context.sampleRate,
					silenceTimeoutMs: 700,
				});
				source = context.createMediaStreamSource(stream);
				processor = context.createScriptProcessor(2048, 1, 1);
				processor.onaudioprocess = (event) => {
					if (disposed || !context) return;
					const data = event.inputBuffer.getChannelData(0);
					const frame = new Float32Array(data);
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
							observation?.shouldFinalize ||
							sampleCount > context.sampleRate * 10
						) {
							speaking = false;
							detector = new VoiceActivityDetector({
								sampleRate: context.sampleRate,
								silenceTimeoutMs: 700,
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
				emit(
					"error",
					error instanceof Error ? error.message : "microphone_unavailable",
				);
				throw error;
			}
		},
		async play(bytes: Uint8Array, onEnded: () => void) {
			if (!context || disposed) throw new Error("audio_not_started");
			this.stopPlayback();
			const epoch = playbackEpoch;
			const buffer = await context.decodeAudioData(
				new Uint8Array(bytes).buffer,
			);
			if (disposed || epoch !== playbackEpoch) return;
			const next = context.createBufferSource();
			next.buffer = buffer;
			next.connect(context.destination);
			playback = next;
			next.onended = () => {
				if (playback === next) {
					playback = undefined;
					emit("listening");
					onEnded();
				}
			};
			next.start();
			emit("playing");
		},
		stopPlayback() {
			playbackEpoch++;
			const old = playback;
			playback = undefined;
			if (old) {
				old.onended = null;
				old.stop();
			}
			emit(context ? "listening" : "idle");
		},
		async stop() {
			disposed = true;
			this.stopPlayback();
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
