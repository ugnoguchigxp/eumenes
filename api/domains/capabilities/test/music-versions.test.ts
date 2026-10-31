import { expect, test } from "bun:test";

test("V3 describes music/vocals/SFX without changing historical schemas", async () => {
	const { musicPlanV3 } = await import("..");
	const base = { title: "音", description: "制作意図", prompt: "test" };
	expect(
		musicPlanV3.parse({ ...base, task: "sound-effect", durationSeconds: 1.5 })
			.durationSeconds,
	).toBe(1.5);
	expect(
		musicPlanV3.parse({
			...base,
			task: "music",
			instrumental: false,
			lyrics: "[Verse]\n朝",
		}).lyrics,
	).toBe("[Verse]\n朝");
	expect(
		musicPlanV3.parse({ ...base, task: "music", instrumental: true })
			.durationSeconds,
	).toBeUndefined();
	for (const invalid of [
		{ task: "vocals" },
		{ task: "music" },
		{ task: "sound-effect", lyrics: "" },
		{ task: "music", instrumental: true, lyrics: "歌詞" },
		{ task: "sound-effect", durationSeconds: 0.9 },
		{ task: "sound-effect", providerOptions: { steps: 8 } },
	])
		expect(musicPlanV3.safeParse({ ...base, ...invalid }).success).toBe(false);
});
