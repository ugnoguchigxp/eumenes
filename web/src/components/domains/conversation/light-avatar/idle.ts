import type { Pose } from "./clips";

const tau = Math.PI * 2;
const ease = (value: number) => value * value * (3 - 2 * value);

function blink(time: number, at: number) {
	const elapsed = time - at;
	if (elapsed < 0 || elapsed > 0.36) return 0;
	return elapsed < 0.12
		? ease(elapsed / 0.12)
		: 1 - ease((elapsed - 0.12) / 0.24);
}
/** `lag` seconds delay the wave; it starts at rest so the static frame stays neutral. */
const wave = (t: number, period: number, lag = 0) =>
	Math.sin((Math.max(0, t - lag) * tau) / period);

/**
 * Breathing, floating, slow sways, wing and flame drift and blinks from the display
 * clock, so cues never restart it. `blinkWeight` fades blinks while a motion acts.
 */
export function sampleIdlePose(time: number, blinkWeight = 1): Pose {
	const t = Math.max(0, time);
	const breath = wave(t, 6);
	const cycle = t % 17;
	const close =
		Math.max(blink(cycle, 2.6), blink(cycle, 7.3), blink(cycle, 12.8)) * 0.97;
	const pose: Pose = {
		"body.py": breath * 0.065,
		"body.x": wave(t, 11) * 0.012,
		"body.y": wave(t, 13) * 0.045,
		"body.z": wave(t, 9) * 0.025,
		"head.x": wave(t, 7) * 0.025,
		"head.y": wave(t, 12) * 0.055,
		"head.z": wave(t, 10) * 0.02,
		"tail_01.z": wave(t, 7.5) * 0.03,
		"tail_02.z": wave(t, 7.5, 1.1) * 0.05,
		"tail_03.z": wave(t, 7.5, 2.2) * 0.07,
		"tail_02.x": wave(t, 9.5) * 0.03,
		"crown_02.z": wave(t, 5.5) * 0.06,
		"crown_03.z": wave(t, 5.5, 0.7) * 0.09,
		"light.energy": breath * 0.012 + 0.05,
	};
	if (close && blinkWeight > 0) pose["eyes.close"] = close * blinkWeight;
	// Wings open and close in mirror; the inner pair follows with a delay.
	for (const [layer, amount, delay] of [
		["outer", 0.035, 0],
		["inner", 0.025, 0.6],
	] as const) {
		const swing = wave(t, 8, delay) * amount;
		pose[`arm_${layer}_l_02.z`] = swing;
		pose[`arm_${layer}_r_02.z`] = -swing;
		pose[`arm_${layer}_l_03.z`] = swing * 1.4;
		pose[`arm_${layer}_r_03.z`] = -swing * 1.4;
	}
	return pose;
}

/** Slow wandering gaze with brief saccades; the head turns partly toward the viewer. */
export function sampleGazePose(
	time: number,
	bodyYaw: number,
	weight = 1,
): Pose {
	const t = Math.max(0, time);
	const hold = 1.7,
		k = Math.floor(t / hold),
		local = t - k * hold;
	// The first hold looks straight ahead, so the static frame stays neutral.
	const target = (n: number) =>
		n <= 0
			? [0, 0]
			: [
					(Math.sin(n * 12.9898) * 43758.5453) % 1,
					(Math.sin(n * 78.233) * 12543.1234) % 1,
				];
	const [ax, ay] = target(k - 1),
		[bx, by] = target(k);
	const s = ease(Math.min(1, local / 0.14));
	return {
		"eyes.gx": (ax! + (bx! - ax!) * s) * 0.018 * weight,
		"eyes.gy": (ay! + (by! - ay!) * s) * 0.01 * weight,
		"head.y": (wave(t, 9.3) * 0.06 - bodyYaw * 0.3) * weight,
		"head.x": wave(t, 6.1, 1.3) * 0.025 * weight,
		"neck.y": -bodyYaw * 0.15 * weight,
	};
}
