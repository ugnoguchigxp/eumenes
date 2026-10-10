import { test, expect } from "bun:test";
import { createSavedBodies } from "../service/saved-bodies";
const owner = { rootRunId: "root", taskId: "child", cancelEpoch: 0 };
function setup(
	text: string,
	limits?: { perTask: number; total: number; count: number },
) {
	let clock = 1000;
	const saved = createSavedBodies(() => clock, limits);
	saved.stage("op", [
		{
			url: "https://example.com/page",
			title: "合成資料",
			text,
			fetchedAt: "2026-10-10T00:00:00Z",
			acquisitionTruncated: false,
		},
	]);
	return {
		saved,
		preview: () => saved.issue("op", owner, 901000, 81000),
		advance: () => (clock = 901001),
	};
}
test("R1/R2/R3: middle and >12000 positions are reached without fetch; raw normalized quote and cursors stay bound to a revision", () => {
	const text =
		"序文".repeat(3200) +
		"中間の料金は１２３円😀。" +
		"余白".repeat(7000) +
		"末尾の結論。";
	const h = setup(text),
		preview = h.preview();
	expect(preview).toHaveLength(2);
	expect(preview.every((p) => p.body.length <= 2400)).toBe(true);
	expect(preview[0]!.body).not.toContain("料金");
	const ref = preview[0]!.sourceRef;
	const found = h.saved.find(owner, { sourceRef: ref, query: "123円😀" });
	expect(found.matches[0]!.start).toBeGreaterThan(5000);
	const read = h.saved.read(owner, {
		sourceRef: ref,
		cursor: found.matches[0]!.cursor,
	});
	expect(read.body).toContain("１２３円😀");
	expect(h.saved.validate(owner, [read])).toBe(true);
	const tail = h.saved.find(owner, { sourceRef: ref, query: "結論" });
	expect(tail.matches[0]!.start).toBeGreaterThan(12000);
	expect(
		h.saved.read(owner, { sourceRef: ref, cursor: tail.matches[0]!.cursor })
			.body,
	).toContain("末尾の結論");
	expect(preview[0]!.viewId).not.toBe(read.viewId);
	expect(() =>
		h.saved.read(owner, {
			sourceRef: preview[1]!.sourceRef,
			cursor: found.cursor ?? crypto.randomUUID(),
		}),
	).toThrow("source_cursor_invalid");
});
test("R7/R8: refetch gets a new immutable revision; foreign owner/cursor/epoch, expiry and restart refuse reads", () => {
	const h = setup("資料Ａ".repeat(1000));
	const first = h.preview()[0]!;
	h.saved.stage("op2", [
		{
			url: first.url,
			title: first.title,
			text: "資料Ｂ".repeat(1000),
			fetchedAt: first.fetchedAt,
			acquisitionTruncated: false,
		},
	]);
	const second = h.saved.issue("op2", owner, 901000, 81000)[0]!;
	expect(second.sourceRevision).not.toBe(first.sourceRevision);
	expect(h.saved.validate(owner, [{ ...first, viewId: second.viewId }])).toBe(
		false,
	);
	expect(() =>
		h.saved.read({ ...owner, taskId: "other" }, { sourceRef: first.sourceRef }),
	).toThrow("source_ref_invalid");
	expect(() =>
		h.saved.find(
			{ ...owner, cancelEpoch: 1 },
			{ sourceRef: first.sourceRef, query: "資料" },
		),
	).toThrow("source_ref_invalid");
	expect(() =>
		h.saved.read(owner, {
			sourceRef: second.sourceRef,
			cursor: first.nextCursor!,
		}),
	).toThrow("source_cursor_invalid");
	h.saved.releaseTask(owner.taskId);
	expect(() => h.saved.read(owner, { sourceRef: first.sourceRef })).toThrow(
		"source_expired",
	);
	expect(h.saved.validate(owner, [first])).toBe(true); // parent validation lives until root deadline
	h.advance();
	expect(h.saved.validate(owner, [first])).toBe(false);
	expect(() =>
		createSavedBodies().read(owner, { sourceRef: first.sourceRef }),
	).toThrow("source_expired");
});
test("capacity never evicts active references and shared bodies survive another owner's release", () => {
	const h = setup("abcdef", { perTask: 6, total: 6, count: 1 });
	const first = h.preview()[0]!;
	const other = { ...owner, rootRunId: "other-root", taskId: "other-child" };
	const shared = h.saved.issue("op", other, 901000, 81000)[0]!;
	h.saved.stage("too-big", [
		{
			url: first.url,
			title: "x",
			text: "too large",
			fetchedAt: first.fetchedAt,
			acquisitionTruncated: false,
		},
	]);
	expect(h.saved.issue("too-big", owner, 901000, 81000)).toEqual([]);
	h.saved.releaseRoot(owner.rootRunId);
	h.saved.forgetDelivery("op");
	expect(h.saved.validate(other, [shared])).toBe(true);
	expect(h.saved.read(other, { sourceRef: shared.sourceRef }).body).toBe(
		"abcdef",
	);
});
test("find normalization preserves grapheme positions; result counts and encoded read sizes are bounded", () => {
	const h = setup("ＡＢＣ e\u0301 😀\n".repeat(4000));
	const preview = h.preview()[0]!;
	const found = h.saved.find(owner, {
		sourceRef: preview.sourceRef,
		query: "abc é 😀",
	});
	expect(found.matches).toHaveLength(5);
	expect(found.hasMore).toBe(true);
	expect(found.matches[0]!.text).toContain("ＡＢＣ e\u0301 😀");
	expect(Buffer.byteLength(JSON.stringify(found))).toBeLessThanOrEqual(8192);
	const read = h.saved.read(owner, {
		sourceRef: preview.sourceRef,
		cursor: found.matches[0]!.cursor,
	});
	expect(Buffer.byteLength(JSON.stringify(read))).toBeLessThanOrEqual(8192);
	expect(read.body).not.toMatch(
		/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u,
	);
});
test("AG-6: a task's cursor quota evicts only its own oldest cursor and never blocks another task", () => {
	const h = setup("abcdef");
	const a = h.preview()[0]!;
	const other = { ...owner, taskId: "other-child" };
	const b = h.saved.issue("op", other, 901000, 81000)[0]!;
	const found = h.saved.find(owner, { sourceRef: a.sourceRef, query: "abc" });
	const first = found.matches[0]!.cursor;
	for (let i = 0; i < 1024; i++)
		h.saved.find(owner, { sourceRef: a.sourceRef, query: "abc" });
	expect(() =>
		h.saved.read(owner, { sourceRef: a.sourceRef, cursor: first }),
	).toThrow("source_cursor_invalid");
	const latest = h.saved.find(owner, { sourceRef: a.sourceRef, query: "abc" });
	expect(
		h.saved.read(owner, {
			sourceRef: a.sourceRef,
			cursor: latest.matches[0]!.cursor,
		}).body,
	).toBe("abcdef");
	expect(
		h.saved.find(other, { sourceRef: b.sourceRef, query: "abc" }).matches,
	).toHaveLength(1);
});
