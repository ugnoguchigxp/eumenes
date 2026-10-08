import type { AvatarMotion } from "../../../../../api/domains/delivery";

export type AvatarCue = { key: string; motion: AvatarMotion };
type Model = {
	beginMotion(): void;
	render(time?: number, motion?: AvatarMotion, elapsed?: number): void;
};

export function createAvatarPlayback(
	model: Model,
	options: {
		reduced?: boolean;
		now?: () => number;
		requestFrame?: (callback: FrameRequestCallback) => number;
		cancelFrame?: (id: number) => void;
		onError?: () => void;
	} = {},
) {
	const now = options.now ?? (() => performance.now());
	const request = options.requestFrame ?? requestAnimationFrame;
	const cancel = options.cancelFrame ?? cancelAnimationFrame;
	let frame = 0,
		started = 0,
		lastFrame = -Infinity,
		elapsed = 0;
	let motion: AvatarMotion = "neutral";
	let key: string | null = null;
	let disposed = false;
	const stop = () => {
		cancel(frame);
		frame = 0;
	};
	function draw() {
		try {
			model.render(elapsed, motion, elapsed);
		} catch {
			stop();
			disposed = true;
			options.onError?.();
		}
	}
	function tick(timestamp: number) {
		if (disposed) return;
		if (timestamp - lastFrame >= 1000 / 24) {
			lastFrame = timestamp;
			elapsed = Math.min((timestamp - started) / 1000, 8.7);
			if (elapsed >= 8) {
				motion = "neutral";
				try {
					model.render(8, "neutral", elapsed - 8);
				} catch {
					stop();
					disposed = true;
					options.onError?.();
				}
			} else draw();
		}
		if (!disposed && elapsed < 8.7) frame = request(tick);
		else stop();
	}
	return {
		setCue(cue: AvatarCue | null) {
			if (disposed || key === (cue?.key ?? null)) return;
			key = cue?.key ?? null;
			stop();
			motion = cue?.motion ?? "neutral";
			model.beginMotion();
			if (options.reduced || !cue || motion === "neutral") {
				motion = "neutral";
				elapsed = 1;
				draw();
				return;
			}
			started = now();
			lastFrame = -Infinity;
			elapsed = 0;
			frame = request(tick);
		},
		redraw: draw,
		dispose() {
			disposed = true;
			stop();
		},
	};
}
