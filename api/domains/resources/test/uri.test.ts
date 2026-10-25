import { expect, test } from "bun:test";
import {
	RESOURCE_ID_MAX,
	formatResourceUri,
	parseResourceUri,
	resourceUriSchema,
} from "..";

test("a formatted URI parses back to the same kind and id, including encoded ids", () => {
	for (const [kind, id] of [
		["image", "image_2999a4578d494fb7a4be6c0428a83c55"],
		["music.track", "music_b6f7766f-9a7c-4080-be7c-83d7ae783864"],
		["report", "web-research:7f1c0d2e/日本語 ?#%"],
		["event", "main:e174"],
		["code.task", "a".repeat(RESOURCE_ID_MAX)],
	] as const) {
		const uri = formatResourceUri(kind, id);
		expect(uri.startsWith(`eumenes://${kind}/`)).toBe(true);
		expect(uri.slice(`eumenes://${kind}/`.length)).not.toMatch(/[/?# ]/);
		expect(parseResourceUri(uri)).toEqual({ uri, kind, id });
	}
	expect(formatResourceUri("event", "main:e174")).toBe(
		"eumenes://event/main%3Ae174",
	);
});

test("the action is read but never kept in the stored form", () => {
	expect(parseResourceUri("eumenes://music.playlist/3b0f?action=play")).toEqual(
		{
			uri: "eumenes://music.playlist/3b0f",
			kind: "music.playlist",
			id: "3b0f",
			action: "play",
		},
	);
	expect(parseResourceUri("  EUMENES://Image/abc  ")).toEqual({
		uri: "eumenes://image/abc",
		kind: "image",
		id: "abc",
	});
});

test("inputs outside the grammar are rejected", () => {
	for (const text of [
		"",
		"image/abc",
		"https://image/abc",
		"eumenes://Image_X/abc", // underscore is not in a kind
		"eumenes://image.bad_x/abc",
		"eumenes://image./abc",
		"eumenes:///abc",
		"eumenes://image",
		"eumenes://image/",
		"eumenes://image/a/b",
		"eumenes://image/abc#frag",
		"eumenes://image/%E0%A4%A", // undecodable
		"eumenes://image/abc?action=delete",
		"eumenes://image/abc?action=play&action=open",
		"eumenes://image/abc?action=play&x=1",
		"eumenes://image/abc?x=1",
		`eumenes://image/${"a".repeat(RESOURCE_ID_MAX + 1)}`,
	])
		expect(parseResourceUri(text)).toBeNull();
	expect(resourceUriSchema.safeParse("eumenes://image/abc").success).toBe(true);
	expect(resourceUriSchema.safeParse("eumenes://nope/").success).toBe(false);
	expect(
		resourceUriSchema.safeParse(`eumenes://image/${"a".repeat(600)}`).success,
	).toBe(false);
});

test("formatting refuses a bad kind and an empty or overlong id", () => {
	expect(() => formatResourceUri("Image", "a")).toThrow(
		"resource_kind_invalid",
	);
	expect(() => formatResourceUri("image", "")).toThrow("resource_id_invalid");
	expect(() =>
		formatResourceUri("image", "a".repeat(RESOURCE_ID_MAX + 1)),
	).toThrow("resource_id_invalid");
});
