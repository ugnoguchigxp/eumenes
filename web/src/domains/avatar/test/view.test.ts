import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { defaultAvatarView, readAvatarView, saveAvatarView } from "../view";

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

test("saved framing is restored and resetting replaces the persisted values", () => {
	expect(readAvatarView()).toEqual(defaultAvatarView);
	saveAvatarView({ zoom: 2.45, x: -0.17, y: 0.09 });
	expect(readAvatarView()).toEqual({ zoom: 2.45, x: -0.17, y: 0.09 });
	saveAvatarView(defaultAvatarView);
	expect(readAvatarView()).toEqual(defaultAvatarView);
});

test.each([
	"{broken",
	"null",
	"[]",
	'"text"',
	"{}",
	'{"zoom":"2","x":0,"y":0}',
	'{"zoom":4,"x":0,"y":0}',
	'{"zoom":0.4,"x":0,"y":0}',
	'{"zoom":2,"x":0.51,"y":0}',
	'{"zoom":2,"x":0,"y":-0.51}',
	'{"zoom":1e400,"x":0,"y":0}',
])("invalid browser data cannot enter the projection: %s", (raw) => {
	saveAvatarView(defaultAvatarView);
	localStorage.setItem(localStorage.key(0)!, raw);
	expect(readAvatarView()).toEqual(defaultAvatarView);
});

test("blocked or full storage does not throw into the rendering lifecycle", () => {
	vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
		throw new DOMException("full", "QuotaExceededError");
	});
	expect(() => saveAvatarView({ zoom: 2, x: 0.1, y: 0 })).not.toThrow();
	vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
		throw new DOMException("blocked", "SecurityError");
	});
	expect(readAvatarView()).toEqual(defaultAvatarView);
	expect(() => saveAvatarView(defaultAvatarView)).not.toThrow();
});
