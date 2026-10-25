import {
	correctionResult,
	validateCorrection,
	type CorrectionResult,
} from "../contracts/correction";
import type { CorrectionPlan } from "../contracts/correction-plan";

type Range = { line: number; start: number; end: number };
type Parts = Extract<
	CorrectionPlan["blocks"][number],
	{ kind: "paragraph" }
>["parts"];
const invalid = () => new Error("ocr_correction_invalid_plan");
const overlaps = (a: Range, b: Range) =>
	a.line === b.line && a.start < b.end && b.start < a.end;

/** Resolve only an exact, unique source selector; never guess an intended span. */
function locate(lines: readonly string[], line: number, text?: string): Range {
	const original = lines[line];
	if (original === undefined) throw invalid();
	if (text === undefined) return { line, start: 0, end: original.length };
	const start = original.indexOf(text);
	if (!text.length || start < 0 || original.indexOf(text, start + 1) >= 0)
		throw invalid();
	return { line, start, end: start + text.length };
}

/** Validate the complete plan before exposing a result. Semantics stay with the LLM. */
export function applyCorrectionPlan(
	plan: CorrectionPlan,
	lines: readonly string[],
	width: number,
	height: number,
): CorrectionResult {
	const protectedSpans = plan.protectedSpans.map((p) =>
		locate(lines, p.line, "text" in p ? p.text : undefined),
	);
	const edits = plan.edits.map((e) => ({
		...locate(lines, e.line, "before" in e ? e.before : undefined),
		after: e.after,
	}));
	for (let i = 0; i < edits.length; i++) {
		const edit = edits[i]!;
		if (protectedSpans.some((p) => overlaps(edit, p)))
			throw new Error("ocr_correction_protected_edit");
		if (edits.slice(0, i).some((other) => overlaps(edit, other)))
			throw invalid();
	}
	const coverage = lines.map((text) => new Uint8Array(text.length));
	const usedLines = new Set<number>();
	const usedEdits = new Set<(typeof edits)[number]>();
	const usedParts: Range[] = [];
	const compose = (parts: Parts) => {
		const indexes = new Set<number>();
		const text = parts
			.map((part, index) => {
				if (index === 0 && part.join) throw invalid();
				const range = locate(lines, part.line, part.source);
				if (usedParts.some((other) => overlaps(range, other))) throw invalid();
				usedParts.push(range);
				usedLines.add(part.line);
				indexes.add(part.line);
				coverage[part.line]!.fill(1, range.start, range.end);
				let source = lines[part.line]!.slice(range.start, range.end);
				const selected = edits.filter((e) => overlaps(e, range));
				for (const edit of selected.sort((a, b) => b.start - a.start)) {
					if (edit.start < range.start || edit.end > range.end) throw invalid();
					usedEdits.add(edit);
					source =
						source.slice(0, edit.start - range.start) +
						edit.after +
						source.slice(edit.end - range.start);
				}
				return (part.join ?? "") + source;
			})
			.join("");
		return { text, evidence: { lineIndexes: [...indexes] } };
	};
	const blocks = plan.blocks.map((block) => {
		const flags = {
			uncertain: block.uncertain,
			...(block.uncertainty === undefined
				? {}
				: { uncertainty: block.uncertainty }),
		};
		if (block.kind === "paragraph")
			return { kind: "paragraph" as const, ...compose(block.parts), ...flags };
		const cells = block.cells.map(({ parts, ...cell }) => ({
			...cell,
			...compose(parts),
		}));
		return {
			kind: "table" as const,
			rows: block.rows,
			columns: block.columns,
			cells,
			evidence: {
				lineIndexes: [...new Set(cells.flatMap((c) => c.evidence.lineIndexes))],
			},
			...flags,
		};
	});
	const excluded = new Set<number>();
	for (const entry of plan.excludedLines) {
		if (
			lines[entry.index] === undefined ||
			usedLines.has(entry.index) ||
			excluded.has(entry.index)
		)
			throw invalid();
		excluded.add(entry.index);
	}
	if (usedEdits.size !== edits.length) throw invalid();
	for (const range of protectedSpans)
		if (
			!coverage[range.line]!.slice(range.start, range.end).every((v) => v === 1)
		)
			throw invalid();
	for (let line = 0; line < lines.length; line++) {
		if (excluded.has(line)) continue;
		if (!usedLines.has(line)) throw invalid();
		// Whitespace between cells is layout; all source characters carrying content must be mapped.
		let remainder = "";
		for (let i = 0; i < lines[line]!.length; i++)
			if (!coverage[line]![i]) remainder += lines[line]![i];
		if (remainder.trim()) throw invalid();
	}
	const result = correctionResult.parse({
		blocks,
		excludedLines: plan.excludedLines,
	});
	validateCorrection(result, lines.length, width, height);
	return result;
}
