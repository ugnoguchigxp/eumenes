import { afterEach, expect, test, vi } from "vitest";
import { createThumbnailQueue } from "./thumbnail-queue";
const flush = async () => {
	for (let i = 0; i < 8; i++) await Promise.resolve();
};
afterEach(() => vi.unstubAllGlobals());
function fixture() {
	URL.createObjectURL = vi.fn(() => "blob:thumbnail");
	URL.revokeObjectURL = vi.fn();
	const options = {
		load: vi.fn(
			async (_id: string, _signal: AbortSignal) => new ArrayBuffer(1),
		),
		render: vi.fn(async (_bytes: ArrayBuffer) => new Blob()),
		dispose: vi.fn(),
	};
	return { ...options, queue: createThumbnailQueue(options) };
}

test("serializes GLB loads and rendering, shares a visible result and revokes after the last observer", async () => {
	const f = fixture();
	let finish!: (blob: Blob) => void;
	f.render.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	const first = vi.fn();
	const releaseA = f.queue.request("a", first);
	const releaseAnotherA = f.queue.request("a", vi.fn());
	const releaseB = f.queue.request("b", vi.fn());
	await flush();
	expect(f.load).toHaveBeenCalledTimes(1);
	finish(new Blob());
	await flush();
	expect(f.load.mock.calls.map(([id]) => id)).toEqual(["a", "b"]);
	expect(first).toHaveBeenLastCalledWith({
		status: "ready",
		url: "blob:thumbnail",
	});
	releaseA();
	expect(URL.revokeObjectURL).not.toHaveBeenCalled();
	releaseAnotherA();
	expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
	releaseB();
	expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
	expect(f.dispose).toHaveBeenCalledTimes(1);
});

test("cancels off-screen work and never adopts its late result; queued cancelled cards never load", async () => {
	const f = fixture();
	let finish!: (bytes: ArrayBuffer) => void;
	f.load.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	const listener = vi.fn();
	const release = f.queue.request("a", listener);
	const releaseB = f.queue.request("b", vi.fn());
	release();
	releaseB();
	expect(f.load.mock.calls[0]![1].aborted).toBe(true);
	finish(new ArrayBuffer(1));
	await flush();
	expect(f.load).toHaveBeenCalledTimes(1);
	expect(f.render).not.toHaveBeenCalled();
	expect(URL.createObjectURL).not.toHaveBeenCalled();
	expect(listener).toHaveBeenCalledTimes(1);
	expect(f.dispose).toHaveBeenCalledTimes(1);
});

test("a rendering failure releases its context, allows the next card and permits explicit retry", async () => {
	const f = fixture();
	f.render.mockRejectedValueOnce(new Error("context lost"));
	const failed = vi.fn();
	const releaseA = f.queue.request("a", failed);
	const releaseB = f.queue.request("b", vi.fn());
	await flush();
	expect(failed).toHaveBeenLastCalledWith({ status: "error" });
	expect(f.dispose).toHaveBeenCalledTimes(1);
	releaseA();
	const retry = vi.fn();
	const releaseRetry = f.queue.request("a", retry);
	await flush();
	expect(retry).toHaveBeenLastCalledWith({
		status: "ready",
		url: "blob:thumbnail",
	});
	releaseB();
	releaseRetry();
});
