import { expect, test } from "vitest";
import { drawingLocation } from "./location";
test("old links retain main; new links carry an encoded conversation and optional revision", () => {
	const referenceId = crypto.randomUUID();
	expect(drawingLocation(`#drawing/${referenceId}?revision=2`)).toEqual({
		referenceId,
		revision: 2,
		conversationId: "main",
	});
	const conversationId = "design / 構成 & review";
	const query = new URLSearchParams({ conversationId, revision: "3" });
	expect(drawingLocation(`#drawing/${referenceId}?${query}`)).toEqual({
		referenceId,
		revision: 3,
		conversationId,
	});
	query.delete("revision");
	expect(
		drawingLocation(`#drawing/${referenceId}?${query}`)?.revision,
	).toBeUndefined();
});
test("malformed and ambiguous link context is rejected", () => {
	const base = `#drawing/${crypto.randomUUID()}`;
	for (const query of [
		"revision=0",
		"revision=no",
		"revision=9007199254740992",
		"revision=1&revision=2",
		"conversationId=",
		"conversationId=a&conversationId=b",
		"token=secret",
	])
		expect(drawingLocation(`${base}?${query}`)).toBeNull();
	expect(drawingLocation("#drawing/invalid")).toBeNull();
});
