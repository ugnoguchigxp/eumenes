const SAMPLE_RATE = 24000;
const SECONDS = 0.6;
const FREQUENCY = 880;
const AMPLITUDE = 0.15;
const FADE_SECONDS = 0.02;

/** PCM16 mono sine burst. No file, TTS, or network. */
export function timerTonePcm(): Int16Array {
	const samples = Math.round(SAMPLE_RATE * SECONDS);
	const pcm = new Int16Array(samples);
	const fade = Math.round(SAMPLE_RATE * FADE_SECONDS);
	for (let i = 0; i < samples; i++) {
		let envelope = 1;
		if (i < fade) envelope = i / fade;
		else if (i > samples - fade) envelope = (samples - i) / fade;
		const sample =
			Math.sin((2 * Math.PI * FREQUENCY * i) / SAMPLE_RATE) *
			AMPLITUDE *
			envelope;
		pcm[i] = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
	}
	return pcm;
}

export function timerToneWav(pcm = timerTonePcm()): Uint8Array {
	const bytes = new Uint8Array(44 + pcm.length * 2);
	const view = new DataView(bytes.buffer);
	const write = (offset: number, text: string) => {
		for (let i = 0; i < text.length; i++)
			bytes[offset + i] = text.charCodeAt(i);
	};
	write(0, "RIFF");
	view.setUint32(4, bytes.length - 8, true);
	write(8, "WAVE");
	write(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, SAMPLE_RATE, true);
	view.setUint32(28, SAMPLE_RATE * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	write(36, "data");
	view.setUint32(40, pcm.length * 2, true);
	for (let i = 0; i < pcm.length; i++) view.setInt16(44 + i * 2, pcm[i]!, true);
	return bytes;
}

export const TIMER_TONE = {
	sampleRate: SAMPLE_RATE,
	seconds: SECONDS,
	frequency: FREQUENCY,
	amplitude: AMPLITUDE,
	fadeSeconds: FADE_SECONDS,
};
