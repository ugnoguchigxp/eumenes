import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ocrThumbnail } from "./thumbnail";

const created: string[] = [];
const revoked: string[] = [];
beforeEach(() => {
	created.length = 0;
	revoked.length = 0;
	URL.createObjectURL = vi.fn(() => {
		const url = `blob:test/${created.length}`;
		created.push(url);
		return url;
	});
	URL.revokeObjectURL = vi.fn((url: string) => {
		revoked.push(url);
	});
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

test("a source that never decodes yields no thumbnail and releases its object URL", async () => {
	vi.useFakeTimers();
	const result = ocrThumbnail(new Blob(["x"], { type: "image/png" }));
	await vi.advanceTimersByTimeAsync(5000);
	expect(await result).toBeNull();
	expect(created).toEqual(["blob:test/0"]);
	expect(revoked).toEqual(["blob:test/0"]);
});

test("a decode error yields no thumbnail", async () => {
	const original = document.createElement.bind(document);
	vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
		const element = original(tag);
		if (tag === "img")
			queueMicrotask(() => element.dispatchEvent(new Event("error")));
		return element;
	});
	// The error listener is attached synchronously, before the microtask runs.
	expect(await ocrThumbnail(new Blob(["x"], { type: "image/png" }))).toBeNull();
	expect(revoked).toEqual(["blob:test/0"]);
});

test("a decoded source without dimensions yields no thumbnail", async () => {
	const original = document.createElement.bind(document);
	vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
		const element = original(tag);
		if (tag === "img")
			queueMicrotask(() => element.dispatchEvent(new Event("load")));
		return element;
	});
	expect(await ocrThumbnail(new Blob(["x"], { type: "image/png" }))).toBeNull();
	expect(revoked).toEqual(["blob:test/0"]);
});

test("a video source is decoded through a muted video element", async () => {
	const original = document.createElement.bind(document);
	const tags: string[] = [];
	vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
		tags.push(tag);
		const element = original(tag);
		if (tag === "video") {
			vi.spyOn(element as HTMLVideoElement, "load").mockImplementation(
				() => {},
			);
			queueMicrotask(() => element.dispatchEvent(new Event("error")));
		}
		return element;
	});
	expect(await ocrThumbnail(new Blob(["x"], { type: "video/mp4" }))).toBeNull();
	expect(tags).toContain("video");
	expect(tags).not.toContain("img");
});
