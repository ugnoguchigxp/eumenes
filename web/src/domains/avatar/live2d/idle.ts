/** Head-led motion with a quiet lower body; time zero is still. */
export function idleParameters(time: number) {
	const start = 1 - Math.exp(-Math.max(0, time) / 0.6);
	return {
		ParamBreath: (1 - Math.cos((time * Math.PI) / 2.5)) * 0.4,
		ParamAngleX:
			start * (Math.sin(time * 1.05 + 0.35) * 21 + Math.sin(time * 0.41) * 5),
		ParamAngleY:
			start * (Math.sin(time * 1.6) * 10 + Math.sin(time * 0.58) * 4),
		ParamAngleZ:
			start * (Math.sin(time * 0.92) * 16 + Math.sin(time * 0.37) ** 7 * 4),
		ParamBodyAngleX:
			start * (Math.sin(time * 1.05) * 2 + Math.sin(time * 0.53) * 0.5),
		ParamBodyAngleY: start * Math.sin(time * 0.8),
		ParamBodyAngleZ:
			start * (Math.sin(time * 1.05) * 1.2 + Math.sin(time * 0.61) * 0.3),
		ParamEyeBallX: start * Math.sin(time * 0.71) * 0.25,
		ParamEyeBallY: start * Math.sin(time * 0.53) * 0.12,
	};
}
