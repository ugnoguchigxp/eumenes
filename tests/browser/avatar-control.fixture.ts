import { createHiyori } from "../../web/src/domains/avatar/live2d/model";
import { createAudioController } from "../../web/src/domains/audio/controller";
import { createLivePcm, pcm16 } from "../../web/src/domains/audio/live-pcm";
import { readAssistantMouth } from "../../web/src/domains/audio/assistant-speech";
import type { AvatarMotion } from "../../api/domains/delivery/contracts";

declare global {
	interface Window {
		avatarTest: Awaited<ReturnType<typeof setup>>;
	}
}
async function setup() {
	const host = document.getElementById("avatar")!;
	let model = await createHiyori(host, new AbortController().signal);
	const tts = createAudioController(
		() => {},
		() => {},
		() => {},
		{ keepAlive: false },
	);
	await tts.startOutput();
	let live: Awaited<ReturnType<typeof createLivePcm>> | undefined;
	let motion: AvatarMotion = "neutral";
	let frame = 0;
	let last = -Infinity;
	let stopped = false;
	const tick = (time: number) => {
		if (stopped) return;
		if (time - last >= 1000 / 24) {
			last = time;
			model.render(time / 1000, motion, readAssistantMouth());
		}
		frame = requestAnimationFrame(tick);
	};
	frame = requestAnimationFrame(tick);
	const musicContext = new AudioContext();
	await musicContext.resume();
	let music: OscillatorNode | undefined;
	const musicOnly = (value: boolean) => {
		music?.stop();
		music?.disconnect();
		music = undefined;
		if (value) {
			music = musicContext.createOscillator();
			const gain = musicContext.createGain();
			gain.gain.value = 0.15;
			music.connect(gain);
			gain.connect(musicContext.destination);
			music.start();
		}
	};
	// A real Web Audio input stream substitutes for hardware in this fixture only.
	const mic = musicContext.createMediaStreamDestination();
	const microphone = musicContext.createOscillator();
	microphone.connect(mic);
	microphone.start();
	Object.defineProperty(navigator, "mediaDevices", {
		configurable: true,
		value: { getUserMedia: async () => mic.stream },
	});
	const wave = (seconds: number, amplitude: number) =>
		Float32Array.from(
			{ length: 24000 * seconds },
			(_, i) => amplitude * Math.sin((2 * Math.PI * 220 * i) / 24000),
		);
	function wav(seconds: number, amplitude: number) {
		const samples = pcm16(wave(seconds, amplitude));
		const bytes = new Uint8Array(44 + samples.length);
		const view = new DataView(bytes.buffer);
		for (const [at, text] of [
			[0, "RIFF"],
			[8, "WAVE"],
			[12, "fmt "],
			[36, "data"],
		] as const)
			for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i);
		view.setUint32(4, bytes.length - 8, true);
		view.setUint32(16, 16, true);
		view.setUint16(20, 1, true);
		view.setUint16(22, 1, true);
		view.setUint32(24, 24000, true);
		view.setUint32(28, 48000, true);
		view.setUint16(32, 2, true);
		view.setUint16(34, 16, true);
		view.setUint32(40, samples.length, true);
		bytes.set(samples, 44);
		return bytes;
	}
	return {
		stats: () => ({
			...model.stats(),
			mouthInput: readAssistantMouth(),
			canvases: host.querySelectorAll("canvas").length,
		}),
		music: musicOnly,
		expression: (value: AvatarMotion) => {
			motion = value;
		},
		tts: (seconds = 1, amplitude = 0.15, assistantSpeech = true) =>
			tts.play(wav(seconds, amplitude), () => {}, { assistantSpeech }),
		stop: () => tts.stopPlayback(),
		async live(seconds = 0.8, amplitude = 0.15) {
			live ??= await createLivePcm({
				inputDevice: "",
				outputDevice: "",
				echoCancellation: true,
				noiseSuppression: true,
				autoGainControl: true,
				volume: 1,
				muted: false,
				onInput: () => {},
				onPlaying: () => {},
				onError: () => {},
			});
			const bytes = pcm16(wave(seconds, amplitude));
			let text = "";
			for (const byte of bytes) text += String.fromCharCode(byte);
			live.play(btoa(text));
		},
		closeLive() {
			live?.close();
			live = undefined;
		},
		async remount() {
			model.dispose();
			model = await createHiyori(host, new AbortController().signal);
		},
		async close() {
			stopped = true;
			cancelAnimationFrame(frame);
			live?.close();
			await tts.stop();
			musicOnly(false);
			microphone.stop();
			await musicContext.close();
			model.dispose();
		},
	};
}
void setup()
	.then((value) => {
		window.avatarTest = value;
		document.body.dataset.ready = "true";
	})
	.catch((error) => {
		document.body.dataset.error = String(error);
	});
