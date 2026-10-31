import { expect, test, vi } from "vitest";
import { createScreenOutput } from "../screen-output";
import type { OutputController } from "../controller";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
function held() {
	let finish: () => void = () => {};
	const done = new Promise<void>((resolve) => {
		finish = resolve;
	});
	return { done, finish };
}
const fakeOutput = () =>
	({
		startOutput: vi.fn(async () => {}),
		stop: vi.fn(async () => {}),
		stopPlayback: vi.fn(),
		play: vi.fn(async () => {}),
	}) as unknown as OutputController;

test("a notice waits for the reading in progress, and a clause waits for the sounding notice", async () => {
	const screen = createScreenOutput(fakeOutput);
	const order: string[] = [];
	const release = screen.beginSpeech();
	const tone = held();
	const notice = screen.notice(new AbortController().signal, async () => {
		order.push("notice");
		await tone.done;
	});
	await flush();
	expect(order).toEqual([]);
	release();
	await flush();
	expect(order).toEqual(["notice"]);
	const clause = screen.noticeQuiet().then(() => order.push("clause"));
	await flush();
	expect(order).toEqual(["notice"]);
	tone.finish();
	await notice;
	await clause;
	expect(order).toEqual(["notice", "clause"]);
});

test("notices take turns in arrival order and a cancelled waiter is skipped", async () => {
	const screen = createScreenOutput(fakeOutput);
	const order: string[] = [];
	const first = held();
	const one = screen.notice(new AbortController().signal, async () => {
		order.push("one");
		await first.done;
	});
	const cancel = new AbortController();
	const two = screen.notice(cancel.signal, async () => {
		order.push("two");
	});
	const three = screen.notice(new AbortController().signal, async () => {
		order.push("three");
	});
	cancel.abort();
	await expect(two).rejects.toBeDefined();
	first.finish();
	await one;
	await three;
	expect(order).toEqual(["one", "three"]);
});

test("speech goes first: a reading that begins while a notice waits holds the notice back", async () => {
	const screen = createScreenOutput(fakeOutput);
	const order: string[] = [];
	const first = held();
	const one = screen.notice(new AbortController().signal, async () => {
		order.push("one");
		await first.done;
	});
	const two = screen.notice(new AbortController().signal, async () => {
		order.push("two");
	});
	const release = screen.beginSpeech();
	first.finish();
	await one;
	await flush();
	expect(order).toEqual(["one"]);
	release();
	await two;
	expect(order).toEqual(["one", "two"]);
});

test("a voice turn speaking elsewhere holds notices back until it ends", async () => {
	const screen = createScreenOutput(fakeOutput);
	let speaking = true;
	screen.setSpeechElsewhere(() => speaking);
	const sounded = vi.fn(async () => {});
	const notice = screen.notice(new AbortController().signal, sounded);
	await flush();
	expect(sounded).not.toHaveBeenCalled();
	speaking = false;
	screen.changed();
	await notice;
	expect(sounded).toHaveBeenCalledOnce();
});

test("the screen keeps one controller per device and a stale one is never stopped twice", () => {
	const made: OutputController[] = [];
	const screen = createScreenOutput(() => {
		const output = fakeOutput();
		made.push(output);
		return output;
	});
	const a = screen.controller("speaker");
	expect(screen.controller("speaker")).toBe(a);
	const b = screen.controller("headset");
	expect(made[0]!.stop).toHaveBeenCalledOnce();
	screen.discard(a);
	expect(made[0]!.stop).toHaveBeenCalledOnce();
	screen.release();
	expect(made[1]!.stop).toHaveBeenCalledOnce();
	expect(b.device).toBe("headset");
});

test("a started output stays shared when a notice gives up; one that never started is dropped", async () => {
	const made: OutputController[] = [];
	const screen = createScreenOutput(() => {
		const output = fakeOutput();
		made.push(output);
		return output;
	});
	const shared = screen.controller("speaker");
	await screen.start(shared);
	screen.discardUnstarted(shared);
	expect(made[0]!.stop).not.toHaveBeenCalled();
	expect(screen.controller("speaker")).toBe(shared);
	screen.release();
	const stalled = screen.controller("speaker");
	vi.mocked(made[1]!.startOutput).mockRejectedValueOnce(new Error("blocked"));
	await expect(screen.start(stalled)).rejects.toThrow("blocked");
	expect(made[1]!.stop).toHaveBeenCalledOnce();
	expect(screen.controller("speaker")).not.toBe(stalled);
});
