import { expect, test } from "bun:test";
import { speechParameters } from "../service";

const delivery = {
	id: "d",
	motion: "neutral",
	tone: "excited",
	source: "laya",
	confidence: 1,
	latencyMs: 0,
} as never;
test("tone offsets are scaled by autoStrength and stay within bounds", () => {
	const base = { speed: 1, pitchScale: 0, intonationScale: 1 };
	expect(speechParameters(delivery, base)).toEqual({
		speed: 1.08,
		pitchScale: 0.025,
		intonationScale: 1.2,
	});
	expect(speechParameters(delivery, { ...base, autoStrength: 0 })).toEqual(
		base,
	);
	expect(
		speechParameters(delivery, { ...base, autoStrength: 2, pitchScale: 0.14 })
			.pitchScale,
	).toBe(0.15);
});
