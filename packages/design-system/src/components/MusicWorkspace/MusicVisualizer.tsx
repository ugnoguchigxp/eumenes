import { useEffect, useRef } from "react";

export function MusicVisualizer({
	analyser,
	playing,
	active,
	mode,
}: {
	analyser: AnalyserNode | null;
	playing: boolean;
	active: boolean;
	mode: "spectrum" | "waveform";
}) {
	const canvas = useRef<HTMLCanvasElement>(null);
	useEffect(() => {
		const surface = canvas.current;
		if (!surface) return;
		const context = surface.getContext("2d");
		if (!context) return;
		context.clearRect(0, 0, surface.width, surface.height);
		if (!analyser || !active) return;
		const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
		const samples = new Uint8Array(analyser.frequencyBinCount);
		let frame = 0;
		function draw() {
			if (!surface || !context || !analyser) return;
			const width = surface.clientWidth,
				height = surface.clientHeight;
			const ratio = Math.min(window.devicePixelRatio || 1, 2);
			const pixelWidth = Math.round(width * ratio),
				pixelHeight = Math.round(height * ratio);
			if (surface.width !== pixelWidth) surface.width = pixelWidth;
			if (surface.height !== pixelHeight) surface.height = pixelHeight;
			context.setTransform(ratio, 0, 0, ratio, 0, 0);
			context.clearRect(0, 0, width, height);
			const color = getComputedStyle(surface).color;
			context.fillStyle = color;
			context.strokeStyle = color;
			if (mode === "spectrum") {
				analyser.getByteFrequencyData(samples);
				const count = Math.min(48, samples.length);
				const spacing = width / count;
				for (let i = 0; i < count; i++) {
					const value = samples[Math.floor((i * samples.length) / count)] ?? 0;
					const bar = (value / 255) * height * 0.75;
					context.fillRect(
						i * spacing + 1,
						height * 0.8 - bar,
						Math.max(1, spacing - 3),
						Math.max(1, bar),
					);
				}
			} else {
				analyser.getByteTimeDomainData(samples);
				context.beginPath();
				for (let i = 0; i < samples.length; i++) {
					const x = (i / (samples.length - 1)) * width;
					const y = ((samples[i] ?? 128) / 255) * height;
					if (i === 0) context.moveTo(x, y);
					else context.lineTo(x, y);
				}
				context.lineWidth = 2;
				context.stroke();
			}
			if (playing && !reduced.matches && !document.hidden)
				frame = requestAnimationFrame(draw);
		}
		function restart() {
			cancelAnimationFrame(frame);
			draw();
		}
		const observer = new ResizeObserver(restart);
		observer.observe(surface);
		document.addEventListener("visibilitychange", restart);
		reduced.addEventListener("change", restart);
		draw();
		return () => {
			cancelAnimationFrame(frame);
			observer.disconnect();
			document.removeEventListener("visibilitychange", restart);
			reduced.removeEventListener("change", restart);
		};
	}, [analyser, playing, active, mode]);
	return (
		<canvas
			ref={canvas}
			className="music-workspace-canvas"
			aria-label="再生音声のVisualizer"
			role="img"
		/>
	);
}
