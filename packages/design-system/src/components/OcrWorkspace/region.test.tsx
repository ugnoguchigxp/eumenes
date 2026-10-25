import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { ocrLinesInRegion } from "./region";
import { OcrPanel } from "./OcrPanel";
import { OcrPreview } from "./OcrPreview";
import type { OcrWorkspaceProps } from "./types";

afterEach(cleanup);
const lines = [
	{
		text: "範囲内",
		confidence: 0.9,
		polygon: [
			[10, 10],
			[40, 10],
			[40, 20],
			[10, 20],
		] as [number, number][],
	},
	{
		text: "境界をまたぐ",
		confidence: 0.9,
		polygon: [
			[30, 30],
			[70, 30],
			[70, 40],
			[30, 40],
		] as [number, number][],
	},
	{
		text: "範囲外",
		confidence: 0.9,
		polygon: [
			[10, 70],
			[40, 70],
			[40, 80],
			[10, 80],
		] as [number, number][],
	},
];
const item = {
	id: "source",
	name: "notice.png",
	mime: "image/png",
	state: "completed" as const,
	revision: 1,
	progress: null,
	errorCode: null,
	result: {
		kind: "image" as const,
		width: 100,
		height: 100,
		text: lines.map((l) => l.text).join("\n"),
		lines,
	},
};
const props: OcrWorkspaceProps = {
	items: [item],
	selectedId: item.id,
	frameIndex: 0,
	selectedLines: [0],
	selectionRegion: [0, 0, 50, 50],
	configured: true,
	connectionRevision: 1,
	baseUrl: null,
};
test("rectangle includes boundary points and excludes a crossing or outside line", () => {
	expect(ocrLinesInRegion(lines, [10, 10, 30, 10])).toEqual([0]);
	expect(ocrLinesInRegion(lines, [0, 0, 50, 50])).toEqual([0]);
	expect(ocrLinesInRegion(lines, [0, 0, 1, 1])).toEqual([]);
});
test("region display and copy keep raw indexes and do not copy an adopted full correction", async () => {
	const user = userEvent.setup(),
		copy = vi.fn(),
		incorporate = vi.fn();
	const { rerender } = render(
		<OcrPanel
			{...props}
			onCopy={copy}
			onIncorporate={incorporate}
			corrections={[
				{
					id: "c",
					sourceId: "source",
					sourceRevision: 1,
					frameIndex: null,
					state: "completed",
					errorCode: null,
					createdAt: 0,
					result: {
						blocks: [
							{
								kind: "paragraph",
								text: "全文の補正案",
								evidence: { lineIndexes: [0, 1, 2] },
								uncertain: false,
							},
						],
						excludedLines: [],
					},
				},
			]}
			correctionPreferredId="c"
		/>,
	);
	expect(
		screen.getByRole("heading", { name: "範囲内のOCR原文（1行）" }),
	).toBeTruthy();
	await user.click(screen.getByRole("button", { name: "範囲内をコピー" }));
	expect(copy).toHaveBeenLastCalledWith("範囲内");
	await user.click(screen.getByRole("tab", { name: "行ごと" }));
	expect(screen.getAllByRole("checkbox")).toHaveLength(1);
	await user.click(
		screen.getByRole("button", { name: "範囲内の原文を会話に追加" }),
	);
	expect(incorporate).toHaveBeenCalledWith("source", undefined, [0]);
	rerender(
		<OcrPanel
			{...props}
			selectionRegion={[0, 0, 1, 1]}
			selectedLines={[]}
			onCopy={copy}
		/>,
	);
	expect(screen.getByRole("button", { name: "範囲内をコピー" })).toBeDisabled();
	expect(
		screen.getByRole("button", { name: "範囲内の原文を会話に追加" }),
	).toBeDisabled();
});
test("preview reuses fullscreen dialog, exposes keyboard-editable rectangle coordinates and closes with Escape", async () => {
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			disconnect() {}
		},
	);
	const user = userEvent.setup(),
		region = vi.fn();
	render(
		<OcrPreview
			{...props}
			item={item}
			width={100}
			height={100}
			mediaUrl="data:image/png;base64,"
			onRegion={region}
		/>,
	);
	await user.click(screen.getByRole("button", { name: "範囲を選ぶ" }));
	expect(screen.getByRole("spinbutton", { name: "範囲の幅" })).toHaveValue(50);
	await user.click(screen.getByRole("button", { name: "大きく表示" }));
	expect(
		screen.getByRole("dialog", { name: "OCR原画像の拡大表示" }),
	).toBeTruthy();
	await user.click(screen.getByRole("button", { name: "拡大" }));
	expect(screen.getByLabelText("拡大倍率")).toHaveTextContent("150%");
	await user.keyboard("{Escape}");
	expect(screen.queryByRole("dialog")).toBeNull();
	await user.click(screen.getByRole("button", { name: "範囲を解除" }));
	expect(region).toHaveBeenLastCalledWith(undefined);
	vi.unstubAllGlobals();
});
