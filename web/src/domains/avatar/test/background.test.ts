import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { readAvatarBackground, saveAvatarBackground } from "../background";
import { readAvatarView, saveAvatarView } from "../view";

const key = "eumenes.avatar.live2d-hiyori.background.v1";

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

test("a chosen colour is restored and choosing the default removes it", () => {
	expect(readAvatarBackground()).toBeNull();
	saveAvatarBackground("#ffeedd");
	expect(readAvatarBackground()).toBe("#ffeedd");
	saveAvatarBackground(null);
	expect(localStorage.getItem(key)).toBeNull();
	expect(readAvatarBackground()).toBeNull();
});

test("saved colours are normalised to lower case", () => {
	localStorage.setItem(key, '{"color":"#A0B1C2"}');
	expect(readAvatarBackground()).toBe("#a0b1c2");
});

test("the background colour and the model framing are stored independently", () => {
	saveAvatarView({ zoom: 2.2, x: 0.1, y: 0 });
	saveAvatarBackground("#123456");
	saveAvatarBackground(null);
	expect(readAvatarView()).toEqual({ zoom: 2.2, x: 0.1, y: 0 });
	saveAvatarBackground("#654321");
	localStorage.removeItem("eumenes.avatar.live2d-hiyori.view.v1");
	expect(readAvatarBackground()).toBe("#654321");
});

test.each([
	"{broken",
	"null",
	"[]",
	'"#123456"',
	"{}",
	'{"color":123456}',
	'{"color":"123456"}',
	'{"color":"#12345"}',
	'{"color":"#1234567"}',
	'{"color":"#12345g"}',
	'{"color":"red"}',
	'{"color":"url(x)"}',
	'{"color":"#123456; background-image:url(x)"}',
])("invalid browser data cannot reach the drawing area: %s", (raw) => {
	localStorage.setItem(key, raw);
	expect(readAvatarBackground()).toBeNull();
});

test("blocked or full storage does not throw into the rendering lifecycle", () => {
	vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
		throw new DOMException("full", "QuotaExceededError");
	});
	expect(() => saveAvatarBackground("#ffffff")).not.toThrow();
	vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
		throw new DOMException("blocked", "SecurityError");
	});
	expect(readAvatarBackground()).toBeNull();
	expect(() => saveAvatarBackground(null)).not.toThrow();
});
