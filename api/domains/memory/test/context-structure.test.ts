import { afterEach, expect, test } from "bun:test";
import { configureLogging } from "../../../infrastructure/logger";
import {
	type LayerBlock,
	layerText,
	longTermFromText,
	renderLongTerm,
	renderShortTerm,
	shortTermFromText,
	type StateLine,
} from "../service/context-render";
import { type MemoryHarness, setupMemory } from "./memory.fixture";

afterEach(() => configureLogging({ level: "silent" }));

const state = (
	n: number,
	kind: string,
	extra: Partial<StateLine> = {},
): StateLine => ({
	itemId: `state:${n}`,
	revision: 1,
	kind,
	text: `項目${n}`,
	negated: false,
	period: "",
	order: n,
	...extra,
});
const tendency = (n: number) => ({
	id: `t${n}`,
	revision: 1,
	text: `傾向${n}`,
	order: `2026-10-0${n}`,
});
const note = (id: string, kind: string, n: number) => ({
	id,
	kind,
	text: `${kind}のメモ${n}`,
	order: `2026-10-0${n}`,
});

const longTermText = (block: LayerBlock) => layerText(block, true);
const shortTermText = (block: LayerBlock) => layerText(block, false);

test("L1: empty has no header and no sections", () => {
	const rendered = renderLongTerm([], []);
	expect(rendered.text).toBe("");
	expect(rendered).toMatchObject({ header: "", sections: [] });
});

test("L1: the states form one section without a heading and the text is exactly the old layout", () => {
	const rendered = renderLongTerm(
		[
			state(1, "preference"),
			state(2, "constraint", { negated: true, period: "（2026年9月から）" }),
		],
		[],
	);
	expect(rendered.sections).toEqual([
		{
			items: ["- 制約: 「項目2」ではない（2026年9月から）", "- 好み: 項目1"],
		},
	]);
	expect(rendered.text).toBe(
		`${rendered.header}\n- 制約: 「項目2」ではない（2026年9月から）\n- 好み: 項目1`,
	);
	expect(rendered.header.length).toBeGreaterThan(0);
	expect(rendered.text.startsWith(rendered.header)).toBe(true);
});

test("L1: tendencies come under their own heading after a blank line, also when there are no states", () => {
	const both = renderLongTerm([state(1, "habit")], [tendency(1), tendency(2)]);
	expect(both.sections).toHaveLength(2);
	expect(both.sections[1]).toEqual({
		heading: "傾向（観察。本人の発言ではない）",
		items: ["- 傾向2", "- 傾向1"],
	});
	expect(both.text).toBe(
		`${both.header}\n- 習慣: 項目1\n\n傾向（観察。本人の発言ではない）\n- 傾向2\n- 傾向1`,
	);
	const only = renderLongTerm([], [tendency(1)]);
	expect(only.sections).toEqual([
		{ heading: "傾向（観察。本人の発言ではない）", items: ["- 傾向1"] },
	]);
	expect(only.text).toBe(
		`${only.header}\n\n傾向（観察。本人の発言ではない）\n- 傾向1`,
	);
});

test("L1: over the budget the trimmed sections still reproduce the text, and the same input gives the same output", () => {
	const states = Array.from({ length: 40 }, (_, i) =>
		state(i, i % 2 ? "preference" : "constraint", {
			text: `長い${"あ".repeat(60)}${i}`,
		}),
	);
	const tendencies = [tendency(1), tendency(2)];
	const rendered = renderLongTerm(states, tendencies, 1200);
	expect(rendered.omitted.length).toBeGreaterThan(0);
	expect(rendered.bytes).toBeLessThanOrEqual(1200);
	expect(longTermText(rendered)).toBe(rendered.text);
	expect(renderLongTerm([...states].reverse(), tendencies, 1200)).toEqual(
		rendered,
	);
});

test("L2: recent additions and every kind of note, in screen order, and the text is derived from the sections", () => {
	const notes = [
		note("m", "memo", 1),
		note("a", "activity", 2),
		note("q", "open_question", 3),
		note("d", "decision", 4),
		note("g", "goal", 5),
		note("g2", "goal", 6),
	];
	const rendered = renderShortTerm(
		[state(1, "preference"), state(2, "habit")],
		notes,
	);
	expect(rendered.sections.map((section) => section.heading)).toEqual([
		"最近覚えたこと（長期の一覧に反映前）",
		"目的",
		"決定",
		"未解決事項",
		"最近の活動",
		"メモ",
	]);
	expect(rendered.sections[0]?.items).toEqual([
		"- 習慣: 項目2",
		"- 好み: 項目1",
	]);
	expect(rendered.sections[1]?.items).toEqual([
		"- goalのメモ6",
		"- goalのメモ5",
	]);
	expect(rendered.text).toBe(
		[
			rendered.header,
			"最近覚えたこと（長期の一覧に反映前）",
			"- 習慣: 項目2",
			"- 好み: 項目1",
			"目的",
			"- goalのメモ6",
			"- goalのメモ5",
			"決定",
			"- decisionのメモ4",
			"未解決事項",
			"- open_questionのメモ3",
			"最近の活動",
			"- activityのメモ2",
			"メモ",
			"- memoのメモ1",
		].join("\n"),
	);
	expect(shortTermText(rendered)).toBe(rendered.text);
	expect(
		renderShortTerm(
			[state(2, "habit"), state(1, "preference")],
			[...notes].reverse(),
		),
	).toEqual(rendered);
});

test("L2: empty, and trimmed over the budget", () => {
	const empty = renderShortTerm([], []);
	expect(empty).toMatchObject({ text: "", header: "", sections: [] });
	const notes = Array.from({ length: 12 }, (_, i) =>
		note(`n${i}`, "memo", (i % 9) + 1),
	).map((entry) => ({ ...entry, text: "い".repeat(900) + entry.id }));
	const rendered = renderShortTerm([], notes, 3000);
	expect(rendered.omitted).toBeGreaterThan(0);
	expect(shortTermText(rendered)).toBe(rendered.text);
});

test("layers stored as text only are read back into the same text", () => {
	const longTerm = renderLongTerm(
		[state(1, "constraint"), state(2, "habit")],
		[tendency(1)],
	);
	const fromLong = longTermFromText(longTerm.text);
	expect(fromLong).toEqual({
		header: longTerm.header,
		sections: longTerm.sections,
	});
	const shortTerm = renderShortTerm(
		[state(3, "preference")],
		[note("g", "goal", 1), note("m", "memo", 2)],
	);
	expect(shortTermFromText(shortTerm.text)).toEqual({
		header: shortTerm.header,
		sections: shortTerm.sections,
	});
	expect(longTermFromText("")).toEqual({ header: "", sections: [] });
	// A frame sentence this version does not know is the first line.
	const unknown = longTermFromText("古い枠の文\n- 好み: x");
	expect(unknown).toEqual({
		header: "古い枠の文",
		sections: [{ items: ["- 好み: x"] }],
	});
});

// ---- the stored window ----

const open: MemoryHarness[] = [];
afterEach(async () => {
	for (const h of open.splice(0)) await h.close();
});
async function setup() {
	const h = await setupMemory();
	open.push(h);
	return h;
}

test("a window stored before the layers carried sections reads back with them, and its text unchanged", async () => {
	const h = await setup();
	await h.seed("コーヒーが好き", "food.coffee");
	await h.seed("毎朝走っている", "habit.run", "毎朝走って", "habit");
	await h.note("c1", { kind: "goal", text: "週末に買い物" });
	const built = await h.window("c1");
	expect(built.longTerm.sections.length).toBeGreaterThan(0);
	// Rewrite the row the way an earlier version stored it, under a new build id so the in-process copy is not used.
	await h.store.write((db) => {
		const row = db
			.query(
				"SELECT snapshot FROM memory_context_window WHERE conversation_id = 'c1'",
			)
			.get() as { snapshot: string };
		const old = JSON.parse(row.snapshot);
		old.buildId = "legacy";
		delete old.longTerm.header;
		delete old.longTerm.sections;
		delete old.shortTerm.header;
		delete old.shortTerm.sections;
		delete old.history.boundary;
		delete old.history.summaryCovers;
		db.query(
			"UPDATE memory_context_window SET build_id = 'legacy', snapshot = ? WHERE conversation_id = 'c1'",
		).run(JSON.stringify(old));
	});
	const read = await h.window("c1");
	expect(read.buildId).toBe("legacy");
	expect(read.longTerm.text).toBe(built.longTerm.text);
	expect(read.longTerm.header).toBe(built.longTerm.header);
	expect(read.longTerm.sections).toEqual(built.longTerm.sections);
	expect(read.shortTerm.text).toBe(built.shortTerm.text);
	expect(read.shortTerm.header).toBe(built.shortTerm.header);
	expect(read.shortTerm.sections).toEqual(built.shortTerm.sections);
	// Its history has no boundary until the next rebuild fills it.
	expect(read.history.boundary).toBeUndefined();
});
