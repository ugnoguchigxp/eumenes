import { expect, test } from "bun:test";
import { createActivityRecorder } from "../service/activity";

test("records running calls, successes and failure codes but not cancelled calls", async () => {
	let clock = 10;
	const recorder = createActivityRecorder(() => clock);
	let finish!: () => void;
	const pending = recorder.track(
		() => new Promise<void>((resolve) => (finish = resolve)),
	);
	expect(recorder.observe().running).toBe(1);
	finish();
	await pending;
	expect(recorder.observe()).toEqual({
		running: 0,
		lastSuccessAt: 10,
		lastFailure: null,
	});
	clock = 20;
	await expect(
		recorder.track(() => Promise.reject(new Error("larm_failed"))),
	).rejects.toThrow("larm_failed");
	clock = 30;
	await expect(
		recorder.track(() =>
			Promise.reject(new Error("Provider said: something long")),
		),
	).rejects.toThrow();
	expect(recorder.observe().lastFailure).toEqual({ at: 30, reason: "failed" });
	const aborted = new AbortController();
	aborted.abort();
	clock = 40;
	await expect(
		recorder.track(
			() => Promise.reject(new Error("larm_failed")),
			aborted.signal,
		),
	).rejects.toThrow();
	expect(recorder.observe().lastFailure?.at).toBe(30);
});

test("a call cut by its deadline is a failure, unlike a cancellation", async () => {
	const recorder = createActivityRecorder(() => 50);
	const deadline = new AbortController();
	deadline.abort(new DOMException("decision deadline", "TimeoutError"));
	await expect(
		recorder.track(() => Promise.reject(new Error("aborted")), deadline.signal),
	).rejects.toThrow();
	expect(recorder.observe().lastFailure).toEqual({
		at: 50,
		reason: "deadline_exceeded",
	});
});
