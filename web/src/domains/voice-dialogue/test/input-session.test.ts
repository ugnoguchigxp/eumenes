import { expect, test } from "vitest";
import { AUTOMATIC_INPUT_MS, createInputSession } from "../hooks/input-session";

test("short accepted input stays automatic; late input remains a draft even after another utterance", () => {
	let now = 0;
	const input = createInputSession(() => now);
	input.begin("first");
	expect(input.isCapturing()).toBe(true);
	input.end("first");
	now = 500;
	input.receive("first");
	now = 100_000;
	expect(input.canCommit("first")).toBe(true);
	input.begin("late");
	input.end("late");
	now += AUTOMATIC_INPUT_MS;
	input.receive("late");
	expect(input.canCommit("late")).toBe(false);
	expect(input.reason()).toBe("delayed");
	input.begin("next");
	input.end("next");
	input.receive("next");
	expect(input.canCommit("next")).toBe(false);
	input.reset();
	expect(input.reason()).toBeNull();
});

test("editing, disconnect and obsolete results cannot gain automatic send authority", () => {
	for (const reason of ["edited", "disconnected"] as const) {
		const input = createInputSession();
		input.begin("old");
		input.end("old");
		input.hold(reason);
		input.begin("new");
		input.receive("old");
		expect(input.isCapturing()).toBe(true);
		expect(input.canCommit("old")).toBe(false);
		input.end("new");
		input.receive("new");
		expect(input.canCommit("new")).toBe(false);
	}
});

test("a late earlier segment keeps the combined input manual", () => {
	let now = 0;
	const input = createInputSession(() => now);
	input.begin("first");
	input.end("first");
	now = 9_000;
	input.begin("second");
	input.end("second");
	now = 11_000;
	input.receive("second");
	expect(input.canCommit("second")).toBe(false);
	input.hold("edited");
	expect(input.reason()).toBe("edited");
});

test("discarded capture restores the pending input rather than leaving a phantom recording", () => {
	const input = createInputSession();
	input.begin("noise");
	expect(input.discardCapture()).toBeNull();
	input.begin("first");
	input.end("first");
	input.receive("first");
	input.begin("discarded");
	expect(input.discardCapture()).toBe("first");
	expect(input.isCapturing()).toBe(false);
	expect(input.canCommit("first")).toBe(true);
});
