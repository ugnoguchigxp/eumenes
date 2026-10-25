import { expect, test } from "bun:test";
import { correctionPlan } from "../contracts/correction-plan";
import { correctionPlainText } from "../contracts/correction";
import { applyCorrectionPlan } from "../service/correction-plan";

const lines = [
	"製品の仕樣や取扱方怯",
	"など尋部は右記の案内を",
	"ご確詔ください。",
	"型番: OCR-172 / AB-10O",
	"定格: 12 V / 1.5 A",
];
const plan = () =>
	correctionPlan.parse({
		protectedSpans: [
			{ line: 3, text: "OCR-172" },
			{ line: 3, text: "AB-10O" },
			{ line: 4, text: "12 V" },
			{ line: 4, text: "1.5 A" },
		],
		edits: [
			{ line: 0, before: "仕樣", after: "仕様" },
			{ line: 0, before: "方怯", after: "方法" },
			{ line: 1, before: "尋部", after: "詳細" },
			{ line: 2, before: "確詔", after: "確認" },
		],
		blocks: [
			{
				kind: "paragraph",
				parts: [{ line: 0 }, { line: 1 }, { line: 2 }],
				uncertain: false,
			},
			{
				kind: "paragraph",
				parts: [{ line: 3 }],
				uncertain: true,
				uncertainty: "末尾の英字は元の表記を保持した",
			},
			{ kind: "paragraph", parts: [{ line: 4 }], uncertain: false },
		],
		excludedLines: [],
	});
const apply = (p = plan(), source = lines) =>
	applyCorrectionPlan(p, source, 820, 360);

test("source edits repair prose and join wrapped lines while copying identifiers exactly", () => {
	const p = plan(),
		source = [...lines];
	const result = apply(p, source);
	expect(correctionPlainText(result)).toBe(
		"製品の仕様や取扱方法など詳細は右記の案内をご確認ください。\n\n型番: OCR-172 / AB-10O\n\n定格: 12 V / 1.5 A",
	);
	expect(result.blocks[0]!.evidence.lineIndexes).toEqual([0, 1, 2]);
	expect(result.blocks[1]!.uncertain).toBe(true);
	expect(source).toEqual(lines);
	expect(p).toEqual(plan());
});
test("a conflicting edit rejects the whole plan rather than partially applying valid edits", () => {
	const p = plan();
	p.edits.push({ line: 3, before: "AB-10O", after: "AB-100" });
	expect(() => apply(p)).toThrow("ocr_correction_protected_edit");
	expect(lines[0]).toBe("製品の仕樣や取扱方怯");
});
test("missing or ambiguous source selectors and overlapping edits are rejected", () => {
	for (const edit of [
		{ line: 0, before: "仕様", after: "使用" },
		{ line: 0, before: "取扱方怯", after: "取扱方法" },
		{ line: 99, before: "不存在", after: "文字" },
	]) {
		const p = plan();
		p.edits.push(edit);
		expect(() => apply(p)).toThrow("ocr_correction_invalid_plan");
	}
	const p = correctionPlan.parse({
		protectedSpans: [],
		edits: [{ line: 0, before: "点", after: "店" }],
		blocks: [{ kind: "paragraph", parts: [{ line: 0 }], uncertain: false }],
		excludedLines: [],
	});
	expect(() => apply(p, ["点と点"])).toThrow("ocr_correction_invalid_plan");
});
test("unmapped words, duplicated parts, discarded edits and dropped protected spans fail", () => {
	const missing = plan();
	missing.blocks[0] = {
		kind: "paragraph",
		parts: [{ line: 0, source: "製品" }, { line: 1 }, { line: 2 }],
		uncertain: false,
	};
	expect(() => apply(missing)).toThrow("ocr_correction_invalid_plan");
	const duplicate = plan();
	duplicate.blocks.push(duplicate.blocks[1]!);
	expect(() => apply(duplicate)).toThrow("ocr_correction_invalid_plan");
	const excluded = plan();
	excluded.blocks.splice(0, 1);
	excluded.excludedLines.push(
		...[0, 1, 2].map((index) => ({ index, reason: "除外" })),
	);
	expect(() => apply(excluded)).toThrow("ocr_correction_invalid_plan");
	const protectedLine = plan();
	protectedLine.blocks.splice(1, 1);
	protectedLine.excludedLines.push({ index: 3, reason: "除外" });
	expect(() => apply(protectedLine)).toThrow("ocr_correction_invalid_plan");
});
test("table cells can refer to separate parts of a source line, preserving values and evidence", () => {
	const p = correctionPlan.parse({
		protectedSpans: [{ line: 1, text: "ZZ-7O" }],
		edits: [{ line: 0, before: "項日", after: "項目" }],
		blocks: [
			{
				kind: "table",
				rows: 2,
				columns: 2,
				cells: [
					{
						row: 0,
						column: 0,
						parts: [{ line: 0, source: "項日" }],
						uncertain: false,
					},
					{
						row: 0,
						column: 1,
						parts: [{ line: 0, source: "値" }],
						uncertain: false,
					},
					{
						row: 1,
						column: 0,
						parts: [{ line: 1, source: "型番" }],
						uncertain: false,
					},
					{
						row: 1,
						column: 1,
						parts: [{ line: 1, source: "ZZ-7O" }],
						uncertain: false,
					},
				],
				uncertain: false,
			},
		],
		excludedLines: [],
	});
	const result = apply(p, ["項日   値", "型番  ZZ-7O"]);
	expect(correctionPlainText(result)).toBe("項目\t値\n型番\tZZ-7O");
	expect(result.blocks[0]!.evidence.lineIndexes).toEqual([0, 1]);
	if (p.blocks[0]?.kind === "table") p.blocks[0].cells[1]!.column = 0;
	expect(() => apply(p, ["項日   値", "型番  ZZ-7O"])).toThrow(
		"ocr_correction_invalid_table",
	);
});
test("insertions, deletions, Unicode, and explicit word spaces apply only to selected source ranges", () => {
	const p = correctionPlan.parse({
		protectedSpans: [{ line: 2, text: "🧪-O1" }],
		edits: [
			{ line: 0, before: "Goood", after: "Good" },
			{ line: 1, before: "mornng", after: "morning" },
		],
		blocks: [
			{
				kind: "paragraph",
				parts: [{ line: 0 }, { line: 1, join: " " }],
				uncertain: false,
			},
			{ kind: "paragraph", parts: [{ line: 2 }], uncertain: false },
		],
		excludedLines: [{ index: 3, reason: "空行" }],
	});
	expect(correctionPlainText(apply(p, ["Goood", "mornng", "🧪-O1", ""]))).toBe(
		"Good morning\n\n🧪-O1",
	);
	p.blocks[0]!.uncertain = true;
	expect(() => apply(p, ["Goood", "mornng", "🧪-O1", ""])).toThrow(
		"ocr_correction_invalid_evidence",
	);
});
test("edit schema forbids arbitrary prose joins and malformed legacy completions", () => {
	expect(
		correctionPlan.safeParse({
			...plan(),
			blocks: [
				{
					kind: "paragraph",
					parts: [{ line: 0, join: "してください" }],
					uncertain: false,
				},
			],
		}).success,
	).toBe(false);
	expect(
		correctionPlan.safeParse({
			blocks: [{ kind: "paragraph", text: "創作文" }],
			excludedLines: [],
		}).success,
	).toBe(false);
});
test("explicit whole-line references avoid source retranscription and retain the same protection checks", () => {
	const p = plan();
	p.edits = [
		{ line: 0, wholeLine: true, after: "製品の仕様や取扱方法" },
		{ line: 1, wholeLine: true, after: "など詳細は右記の案内を" },
		{ line: 2, wholeLine: true, after: "ご確認ください。" },
	];
	p.protectedSpans = [
		{ line: 3, wholeLine: true },
		{ line: 4, wholeLine: true },
	];
	expect(correctionPlainText(apply(p))).toContain(
		"仕様や取扱方法など詳細は右記の案内をご確認ください。",
	);
	p.edits.push({ line: 3, wholeLine: true, after: "型番: OCR-172 / AB-10O" });
	expect(() => apply(p)).toThrow("ocr_correction_protected_edit");
	expect(
		correctionPlan.safeParse({
			...plan(),
			edits: [{ line: 0, after: "元文にない文" }],
		}).success,
	).toBe(false);
	expect(
		correctionPlan.safeParse({ ...plan(), protectedSpans: [{ line: 3 }] })
			.success,
	).toBe(false);
});
