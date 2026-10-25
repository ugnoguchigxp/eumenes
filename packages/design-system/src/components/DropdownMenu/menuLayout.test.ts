import { describe, expect, it } from "vitest";
import { layoutMenu, type MenuPlacement, type MenuSize } from "./menuLayout";

const placement: MenuPlacement = {
	align: "right",
	side: "bottom",
	autoFlip: true,
	autoSide: true,
	offset: 8,
	minWidthPx: 240,
};
const trigger = {
	top: 8,
	bottom: 44,
	left: 900,
	right: 936,
	width: 36,
} as DOMRect;
const viewport = { left: 0, top: 0, width: 1000, height: 600 };
const size: MenuSize = {
	width: 240,
	height: 696,
	rowHeight: 40,
	chrome: 16,
	count: 17,
};

describe("menu layout", () => {
	it("fills one column then wraps into a second inside the available viewport", () => {
		const layout = layoutMenu(trigger, size, viewport, placement);
		expect(layout.columnRows).toBe(13);
		expect(layout.menuStyle).toMatchObject({
			left: 456,
			top: 52,
			width: 480,
			maxHeight: 540,
		});
		expect(layout.listStyle.gridTemplateRows).toBe(
			"repeat(13, minmax(40px, auto))",
		);
	});
	it("returns to one column when the viewport gets tall enough", () => {
		const layout = layoutMenu(
			trigger,
			size,
			{ ...viewport, height: 900 },
			placement,
		);
		expect(layout.columnRows).toBe(0);
		expect(layout.menuStyle.width).toBe(240);
	});
	it("keeps one scrolling column when there is not room for two full-width columns", () => {
		const layout = layoutMenu(
			trigger,
			size,
			{ ...viewport, width: 390 },
			placement,
		);
		expect(layout.columnRows).toBe(0);
		expect(layout.menuStyle).toMatchObject({
			left: 142,
			width: 240,
			maxHeight: 540,
			overflowY: "auto",
		});
	});
	it("clamps long labels and wide triggers to the viewport without offscreen placement", () => {
		const layout = layoutMenu(
			{ ...trigger, width: 500 } as DOMRect,
			{ ...size, width: 900 },
			{ ...viewport, width: 300 },
			placement,
		);
		expect(layout.columnRows).toBe(0);
		expect(layout.menuStyle).toMatchObject({
			left: 8,
			width: 284,
			maxWidth: 284,
		});
	});
	it("uses the actual tallest row to account for multiline labels", () => {
		const layout = layoutMenu(
			trigger,
			{ ...size, rowHeight: 80, height: 736 },
			viewport,
			placement,
		);
		expect(layout.columnRows).toBe(9);
		expect(layout.menuStyle.maxHeight).toBe(540);
		expect(layout.listStyle.gridTemplateRows).toBe(
			"repeat(9, minmax(80px, auto))",
		);
	});
	it("retains a vertical scroll when more than two columns worth of entries exist", () => {
		const layout = layoutMenu(
			trigger,
			{ ...size, count: 40, height: 1616 },
			viewport,
			placement,
		);
		expect(layout.columnRows).toBe(20);
		expect(layout.menuStyle).toMatchObject({
			width: 480,
			maxHeight: 540,
			overflowY: "auto",
		});
	});
	it("opens upward without clipping its top, using the split height", () => {
		const layout = layoutMenu(
			{ ...trigger, top: 550, bottom: 586 } as DOMRect,
			size,
			viewport,
			placement,
		);
		expect(layout.columnRows).toBe(12);
		expect(layout.menuStyle).toMatchObject({ top: 46, maxHeight: 534 });
	});
	it("honors a forced side and accounts for the gap even in a short viewport", () => {
		const layout = layoutMenu(
			trigger,
			size,
			{ ...viewport, height: 150 },
			{ ...placement, autoSide: false },
		);
		expect(layout.menuStyle).toMatchObject({ top: 52, maxHeight: 90 });
	});
	it("uses visual viewport offsets when the visible area is panned or zoomed", () => {
		const layout = layoutMenu(
			trigger,
			size,
			{ ...viewport, left: 50, top: 20, width: 300 },
			placement,
		);
		expect(layout.menuStyle.left).toBe(102);
		expect(layout.menuStyle.maxHeight).toBe(560);
	});
});
