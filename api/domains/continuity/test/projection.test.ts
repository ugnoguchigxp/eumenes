import { expect, test } from "bun:test";
import type { Bookmark, ContinuitySnapshot, SourceStatus } from "../contracts";
import { projectContinuity } from "../projection";

function bookmark(id: string, overrides: Partial<Bookmark> = {}): Bookmark {
	return {
		id,
		conversationId: "c1",
		kind: "goal",
		text: `text ${id}`,
		status: "active",
		revision: 1,
		origin: "user_confirmed",
		sourceMessageId: `m-${id}`,
		sourceDigest: `d-${id}`,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

function snapshot(
	items: Array<{ bookmark: Bookmark; sourceStatus?: SourceStatus }>,
	stateRevision = 7,
): ContinuitySnapshot {
	return {
		conversationId: "c1",
		stateRevision,
		items: items.map((item) => ({
			bookmark: item.bookmark,
			sourceStatus: item.sourceStatus ?? "ok",
		})),
	};
}

const byteLength = (value: unknown) =>
	new TextEncoder().encode(JSON.stringify(value)).byteLength;

test("empty snapshot is ready with no items", () => {
	expect(projectContinuity(snapshot([]), 10_000)).toEqual({
		status: "ready",
		conversationId: "c1",
		stateRevision: 7,
		instructionAuthority: "none",
		items: [],
	});
});

test("items are mapped and sorted by bookmark id regardless of input order", () => {
	const ids = ["b", "a", "B", "a10", "a2", "c"];
	const forward = projectContinuity(
		snapshot(ids.map((id) => ({ bookmark: bookmark(id) }))),
		100_000,
	);
	const shuffled = projectContinuity(
		snapshot([...ids].reverse().map((id) => ({ bookmark: bookmark(id) }))),
		100_000,
	);
	expect(JSON.stringify(forward)).toBe(JSON.stringify(shuffled));
	if (forward.status !== "ready") throw new Error("expected ready");
	expect(forward.items.map((item) => item.bookmarkId)).toEqual([
		"B",
		"a",
		"a10",
		"a2",
		"b",
		"c",
	]);
	expect(forward.items[0]).toEqual({
		bookmarkId: "B",
		kind: "goal",
		text: "text B",
		origin: "user_confirmed",
		source: { messageId: "m-B", digest: "d-B" },
	});
});

test("exact byte budget is ready and one byte less overflows", () => {
	const snap = snapshot([
		{ bookmark: bookmark("a") },
		{ bookmark: bookmark("b") },
	]);
	const ready = projectContinuity(snap, 1_000_000);
	expect(ready.status).toBe("ready");
	const size = byteLength(ready);
	expect(projectContinuity(snap, size)).toEqual(ready);
	const overflow = projectContinuity(snap, size - 1);
	expect(overflow.status).toBe("overflow");
	expect(overflow).not.toHaveProperty("items");
	expect(overflow).toMatchObject({
		conversationId: "c1",
		stateRevision: 7,
		instructionAuthority: "none",
	});
	expect((overflow as { reason: string }).reason.length).toBeGreaterThan(0);
});

test("budget is measured in UTF-8 bytes, not string length", () => {
	const text = "日本語のしおり🙂🚀";
	const snap = snapshot([{ bookmark: bookmark("a", { text }) }]);
	const ready = projectContinuity(snap, 1_000_000);
	const json = JSON.stringify(ready);
	const bytes = byteLength(ready);
	expect(bytes).toBeGreaterThan(json.length);
	expect(projectContinuity(snap, bytes).status).toBe("ready");
	expect(projectContinuity(snap, bytes - 1).status).toBe("overflow");
	// Would pass if string length were (wrongly) used as the measure.
	expect(projectContinuity(snap, json.length).status).toBe("overflow");
});

test("missing or changed source blocks without partial items", () => {
	for (const bad of ["missing", "changed"] as const) {
		const result = projectContinuity(
			snapshot([
				{ bookmark: bookmark("a") },
				{ bookmark: bookmark("b"), sourceStatus: bad },
			]),
			1_000_000,
		);
		expect(result.status).toBe("blocked");
		expect(result).not.toHaveProperty("items");
		expect(result).toMatchObject({
			conversationId: "c1",
			stateRevision: 7,
			instructionAuthority: "none",
		});
	}
});

test("blocked takes precedence over overflow", () => {
	const result = projectContinuity(
		snapshot([{ bookmark: bookmark("a"), sourceStatus: "changed" }]),
		0,
	);
	expect(result.status).toBe("blocked");
});

test("non-active bookmarks are excluded defensively", () => {
	const result = projectContinuity(
		snapshot([
			{ bookmark: bookmark("a", { status: "inactive" }) },
			{ bookmark: bookmark("b") },
		]),
		1_000_000,
	);
	if (result.status !== "ready") throw new Error("expected ready");
	expect(result.items.map((item) => item.bookmarkId)).toEqual(["b"]);
});

test("input snapshot is not mutated", () => {
	const snap = snapshot([
		{ bookmark: bookmark("b") },
		{ bookmark: bookmark("a") },
	]);
	const before = structuredClone(snap);
	projectContinuity(snap, 1_000_000);
	projectContinuity(snap, 0);
	expect(snap).toEqual(before);
});

test("instructionAuthority is always none", () => {
	const ok = snapshot([{ bookmark: bookmark("a") }]);
	const bad = snapshot([{ bookmark: bookmark("a"), sourceStatus: "missing" }]);
	for (const result of [
		projectContinuity(ok, 1_000_000),
		projectContinuity(ok, 0),
		projectContinuity(bad, 1_000_000),
		projectContinuity(snapshot([]), 1_000_000),
	]) {
		expect(result.instructionAuthority).toBe("none");
	}
});

test("invalid maxBytes throws RangeError", () => {
	const snap = snapshot([]);
	for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
		expect(() => projectContinuity(snap, bad)).toThrow(RangeError);
	}
});

test("inactive items with a bad source do not block the projection", () => {
	const result = projectContinuity(
		snapshot([
			{ bookmark: bookmark("a") },
			{
				bookmark: bookmark("b", { status: "inactive" }),
				sourceStatus: "missing",
			},
		]),
		10_000,
	);
	expect(result.status).toBe("ready");
});
