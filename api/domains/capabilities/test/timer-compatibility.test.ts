import { expect, test } from "bun:test";
import { hash, timerResultContext, validators } from "../contracts";
import { zSchema } from "../service/schema";

test("timer UI pausing keeps the deployed version 1 input schemas and accepts paused result state", () => {
	// Captured from HEAD before the UI feature: stored capability revisions must still match.
	expect(hash(zSchema("timerList"))).toBe(
		"d06d3a1037587b1c3e12ccbe52592052cf542c1c54e5fc9846ddddda139f5943",
	);
	expect(hash(zSchema("timerCommand"))).toBe(
		"ccec84873264c48f26d6418630d82556bba9d46037f87e6d386b9226d31ce220",
	);
	const context = timerResultContext.parse({
		version: 1,
		kind: "timer_action",
		action: "listed",
		observedAt: "2026-10-13T00:00:00Z",
		items: [
			{
				id: crypto.randomUUID(),
				revision: 1,
				label: "タイマー",
				state: "paused",
				durationSeconds: 90,
				remainingSeconds: 70,
				dueAt: "2026-10-13T00:01:30Z",
			},
		],
		complete: true,
		errorCode: null,
	});
	expect(context.items[0]?.state).toBe("paused");
});

test("the bound-command inputs accept exactly the shapes the UI and the questions send", () => {
	expect(
		validators.timerHms.safeParse({ hours: "0", minutes: "03", seconds: "00" })
			.success,
	).toBe(true);
	for (const bad of [
		{ hours: 0, minutes: "3", seconds: "0" },
		{ hours: "1.5", minutes: "3", seconds: "0" },
		{ hours: "123456", minutes: "3", seconds: "0" },
		{ hours: "", minutes: "3", seconds: "0" },
		{ hours: "0", minutes: "3" },
		{ hours: "0", minutes: "3", seconds: "0", label: "x" },
	])
		expect(validators.timerHms.safeParse(bad).success).toBe(false);
	expect(
		validators.timerTargetAnswer.safeParse({ timerId: crypto.randomUUID() })
			.success,
	).toBe(true);
	expect(validators.timerTargetAnswer.safeParse({ timerId: "x" }).success).toBe(
		false,
	);
	expect(validators.answerText.safeParse({ text: "  3分  " }).data).toEqual({
		text: "3分",
	});
	expect(validators.answerText.safeParse({ text: " " }).success).toBe(false);
	expect(
		validators.answerText.safeParse({ text: "a".repeat(501) }).success,
	).toBe(false);
	expect(validators.emptyInput.safeParse({}).success).toBe(true);
	expect(validators.emptyInput.safeParse({ a: 1 }).success).toBe(false);
});
