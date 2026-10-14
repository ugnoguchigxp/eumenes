import { expect, test } from "vitest";
import { createPerformer, defaultLayers } from "./performer";

const quiet = { gestures: false, gaze: false, secondary: false };

test("a cue crossfades from the previous pose over 0.7 seconds", () => {
	const performer = createPerformer();
	const idle = performer.sample(1, "neutral", 1, false, quiet);
	performer.begin({ variant: "joyful-spin" });
	const start = performer.sample(1.01, "joyful", 0, false, quiet);
	expect(start["body.py"]).toBeCloseTo(idle["body.py"]!, 2);
	const settled = performer.sample(2.5, "joyful", 1.5, false, quiet);
	expect(settled["body.py"]!).toBeGreaterThan(0.2);
	expect(performer.current().variant).toBe("joyful-spin");
});

test("repeated plays of the same emotion differ in variant or pace", () => {
	const performer = createPerformer();
	const samples = [0, 1, 2].map((n) => {
		performer.begin();
		performer.sample(n * 10, "joyful", 0, false, quiet);
		return JSON.stringify(
			performer.sample(n * 10 + 1.6, "joyful", 1.6, false, quiet),
		);
	});
	expect(new Set(samples).size).toBe(3);
});

test("while speaking, a full spin becomes a look back and the speech overlay adds gestures", () => {
	const performer = createPerformer();
	performer.begin({ variant: "joyful-spin" });
	const silent = performer.sample(1, "joyful", 1.6, false, quiet);
	expect(silent.spin!).toBeGreaterThan(1);
	performer.begin({ variant: "joyful-spin" });
	const talking = performer.sample(2, "joyful", 1.6, true, quiet);
	expect(talking.spin ?? 0).toBe(0);
	expect(Math.abs(talking["body.y"]!)).toBeLessThanOrEqual(0.36 + 0.1);
	const neutral = createPerformer();
	const still = neutral.sample(1, "neutral", 1.5, false, quiet);
	neutral.begin();
	const speech = neutral.sample(1, "neutral", 1.5, true, quiet);
	expect(JSON.stringify(speech)).not.toBe(JSON.stringify(still));
});

test("speech loops through the whole audio and meets the rest pose at each boundary", () => {
	const performer = createPerformer();
	performer.begin({ variant: "speaking-gesture" });
	performer.sample(0, "speaking", 0, true, quiet);
	const before = performer.sample(9, "speaking", 7.999, true, quiet);
	const after = performer.sample(9.002, "speaking", 8.001, true, quiet);
	for (const channel of Object.keys(before))
		if (!channel.startsWith("eyes") && !channel.startsWith("light"))
			expect(Math.abs(before[channel]! - (after[channel] ?? 0))).toBeLessThan(
				0.01,
			);
});

test("idle gestures appear only while nothing else acts", () => {
	const performer = createPerformer();
	const layers = { ...defaultLayers, gaze: false };
	const moving = (mode: string) =>
		Array.from({ length: 600 }, (_, i) => {
			const time = i / 10;
			const pose = performer.sample(time, mode, time, false, layers);
			return (
				Math.abs(pose["body.z"] ?? 0) +
				Math.abs(pose.spin ?? 0) +
				Math.abs(pose["head.y"] ?? 0)
			);
		});
	expect(Math.max(...moving("neutral"))).toBeGreaterThan(0.15);
	const acting = createPerformer();
	const quietLayers = { ...layers, gestures: false };
	const plain = Array.from({ length: 600 }, (_, i) => {
		const pose = acting.sample(i / 10, "neutral", i / 10, false, quietLayers);
		return Math.abs(pose["body.z"] ?? 0) + Math.abs(pose["head.y"] ?? 0);
	});
	expect(Math.max(...plain)).toBeLessThan(0.15);
});

test("consecutive cues of one motion never pick the same variant twice in a row", () => {
	const performer = createPerformer();
	const picks = Array.from({ length: 12 }, (_, n) => {
		performer.begin();
		performer.sample(n, "joyful", 0.5, false, quiet);
		return performer.current().variant;
	});
	for (let i = 1; i < picks.length; i++)
		expect(picks[i]).not.toBe(picks[i - 1]);
});
