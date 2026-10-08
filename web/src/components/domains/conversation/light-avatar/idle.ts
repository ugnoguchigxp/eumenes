const tau = Math.PI * 2;
const ease = (value: number) => value * value * (3 - 2 * value);

function blink(time: number, at: number) {
	const elapsed = time - at;
	if (elapsed < 0 || elapsed > 0.36) return 0;
	return elapsed < 0.12
		? ease(elapsed / 0.12)
		: 1 - ease((elapsed - 0.12) / 0.24);
}

/** Additive idle movement uses the display clock, so cues never restart it. */
export function sampleOccasionalSway(time: number) {
	const cycle = Math.max(0, time) % 120;
	const starts = [8, 36, 67, 98];
	for (let i = 0; i < starts.length; i++) {
		const progress = (cycle - starts[i]!) / 4.8;
		if (progress >= 0 && progress <= 1)
			return (
				Math.sin(progress * tau) *
				Math.sin(progress * Math.PI) ** 2 *
				(i % 2 ? -1 : 1)
			);
	}
	return 0;
}

export function sampleIdlePose(time: number, swayWeight = 1) {
	const t = Math.max(0, time);
	const sway =
		sampleOccasionalSway(t) * ease(Math.max(0, Math.min(1, swayWeight)));
	const breath = Math.sin((t * tau) / 6);
	const wings = Math.sin((t * tau) / 8);
	const cycle = t % 17;
	return {
		lift: breath * 0.065,
		bx: Math.sin((t * tau) / 11) * 0.012,
		by: Math.sin((t * tau) / 13) * 0.045 + sway * 0.1,
		bz: Math.sin((t * tau) / 9) * 0.025 + sway * 0.12,
		hx: Math.sin((t * tau) / 7) * 0.025,
		hy: Math.sin((t * tau) / 12) * 0.055 - sway * 0.025,
		hz: Math.sin((t * tau) / 10) * 0.02 - sway * 0.035,
		left: wings * 0.035 + sway * 0.07,
		right: -wings * 0.035 + sway * 0.07,
		leftInner: wings * 0.025,
		rightInner: -wings * 0.025,
		energy: breath * 0.012,
		open:
			1 -
			Math.max(blink(cycle, 2.6), blink(cycle, 7.3), blink(cycle, 12.8)) * 0.97,
	};
}
