import { expect, test } from "vitest";
import { drawingLocation } from "./location";
test("old links retain main; new links carry an encoded conversation and optional revision", () => {
	const referenceId = crypto.randomUUID();
	expect(drawingLocation(`#drawing/${referenceId}?revision=2`)).toEqual({
		kind: "reference",
		referenceId,
		revision: 2,
		conversationId: "main",
	});
	const conversationId = "design / 構成 & review";
	const query = new URLSearchParams({ conversationId, revision: "3" });
	expect(drawingLocation(`#drawing/${referenceId}?${query}`)).toEqual({
		kind: "reference",
		referenceId,
		revision: 3,
		conversationId,
	});
	query.delete("revision");
	const location = drawingLocation(`#drawing/${referenceId}?${query}`);
	expect(location?.kind === "reference" && location.revision).toBe(undefined);
});
test("a new drawing link names only a local draft, an optional title and conversation", () => {
	const draftId = crypto.randomUUID();
	expect(drawingLocation(`#drawing/new/${draftId}`)).toEqual({
		kind: "new",
		draftId,
		title: "新しい図",
		conversationId: "main",
	});
	expect(
		drawingLocation(
			`#drawing/new/${draftId}?${new URLSearchParams({ title: "構成図", conversationId: "c1" })}`,
		),
	).toEqual({ kind: "new", draftId, title: "構成図", conversationId: "c1" });
	for (const query of ["revision=1", "title=", "title=a&title=b"])
		expect(drawingLocation(`#drawing/new/${draftId}?${query}`)).toBeNull();
	expect(drawingLocation("#drawing/new/invalid")).toBeNull();
	expect(drawingLocation(`#drawing/new/${draftId}/x`)).toBeNull();
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
