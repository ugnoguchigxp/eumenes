import { useState, type SetStateAction } from "react";
import { z } from "zod";
import { ocrLinesInRegion, type OcrRegion } from "@eumenes/design-system";
import type { ArtifactEvent, Receipt } from "@eumenes/artifact-ui/contracts";
import type { OcrRecord } from "../../../../api/domains/ocr/contracts";

type Selection = {
	scope: string;
	lines: number[];
	region?: OcrRegion;
	highlight?: OcrRegion;
};
const rectangle = z.tuple([
	z.number().finite().nonnegative(),
	z.number().finite().nonnegative(),
	z.number().finite().min(1),
	z.number().finite().min(1),
]);
export function useOcrSelection(
	selected: OcrRecord | undefined,
	frameIndex: number,
) {
	const scope = `${selected?.id}:${selected?.revision}:${frameIndex}`;
	const [saved, setSaved] = useState<Selection>({ scope, lines: [] });
	const current = saved.scope === scope ? saved : { scope, lines: [] };
	const result = selected?.result;
	const lines =
		result?.kind === "image"
			? result.lines
			: (result?.frames[frameIndex]?.lines ?? []);
	const visible = current.region
		? ocrLinesInRegion(lines, current.region)
		: undefined;
	const update = (change: (value: Selection) => Selection) =>
		setSaved((previous) =>
			change(previous.scope === scope ? previous : { scope, lines: [] }),
		);
	function dispatchRegion(event: ArtifactEvent): Receipt {
		if (
			event.values.id !== selected?.id ||
			!result ||
			selected.state !== "completed" ||
			event.values.scope !== scope
		)
			return { status: "rejected", message: "資料を選び直してください。" };
		if (event.values.region === "") {
			setSaved({ scope, lines: [] });
			return { status: "accepted", message: "範囲を解除しました。" };
		}
		let raw: unknown;
		try {
			raw = JSON.parse(String(event.values.region));
		} catch {
			return { status: "rejected", message: "範囲を選び直してください。" };
		}
		const parsed = rectangle.safeParse(raw);
		if (!parsed.success)
			return { status: "rejected", message: "範囲を選び直してください。" };
		const r = parsed.data,
			size = result.kind === "image" ? result : result.video;
		if (r[0] + r[2] > size.width || r[1] + r[3] > size.height)
			return { status: "rejected", message: "画像内を選んでください。" };
		setSaved({ scope, region: r, lines: ocrLinesInRegion(lines, r) });
		return { status: "accepted", message: "範囲内の行を選択しました。" };
	}
	return {
		selectedLines: current.lines,
		selectionRegion: current.region,
		highlightRegion: current.highlight,
		setSelectedLines(next: SetStateAction<number[]>) {
			update((value) => {
				const indexes = typeof next === "function" ? next(value.lines) : next;
				const allowed = value.region
					? ocrLinesInRegion(lines, value.region)
					: undefined;
				return {
					...value,
					lines: allowed ? indexes.filter((i) => allowed.includes(i)) : indexes,
				};
			});
		},
		setHighlightRegion(highlight: OcrRegion | undefined) {
			update((value) => ({ ...value, highlight }));
		},
		toggleLine(index: number): Receipt {
			if (
				!Number.isInteger(index) ||
				index < 0 ||
				!lines[index] ||
				(visible && !visible.includes(index))
			)
				return { status: "rejected", message: "行を選び直してください。" };
			update((value) => ({
				...value,
				highlight: undefined,
				lines: value.lines.includes(index)
					? value.lines.filter((i) => i !== index)
					: [...value.lines, index].sort((a, b) => a - b),
			}));
			return { status: "accepted", message: "選択しました。" };
		},
		dispatchRegion,
	};
}
