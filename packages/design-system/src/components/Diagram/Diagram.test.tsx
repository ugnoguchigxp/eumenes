import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Diagram, type DiagramElement } from "./Diagram";

const renderDiagram = (
	elements: DiagramElement[],
	props: Partial<React.ComponentProps<typeof Diagram>> = {},
) => render(<Diagram elements={elements} {...props} />);

const elementsOf = (container: HTMLElement, type: string) =>
	container.querySelectorAll(`[data-diagram-element="${type}"]`);

describe("Diagram", () => {
	it("viewBox は aspect ごとの高さを持つ", () => {
		const { rerender } = renderDiagram([]);
		const viewBox = () => screen.getByRole("img").getAttribute("viewBox");
		expect(viewBox()).toBe("0 0 100 56.25");
		rerender(<Diagram elements={[]} aspect="square" />);
		expect(viewBox()).toBe("0 0 100 100");
		rerender(<Diagram elements={[]} aspect="wide" />);
		expect(viewBox()).toBe("0 0 100 42.86");
	});

	it("shape の rect と ellipse を描き、ラベルを中央に置く", () => {
		const { container } = renderDiagram([
			{
				type: "shape",
				shape: "rect",
				x: 10,
				y: 10,
				w: 20,
				h: 10,
				label: "機体",
			},
			{
				type: "shape",
				shape: "ellipse",
				x: 40,
				y: 10,
				w: 20,
				h: 10,
				filled: true,
			},
		]);
		const rect = container.querySelector("rect");
		expect(rect?.getAttribute("width")).toBe("20");
		expect(rect?.getAttribute("fill")).toBe("none");
		const ellipse = container.querySelector("ellipse");
		expect(ellipse?.getAttribute("rx")).toBe("10");
		expect(ellipse?.getAttribute("fill")).toContain("--foreground");
		const text = screen.getByText("機体");
		expect(text.getAttribute("x")).toBe("20");
		expect(text.getAttribute("y")).toBe("15");
	});

	it("rotate は反時計回りを正とし、SVG の負の回転へ変換する", () => {
		const { container } = renderDiagram([
			{ type: "shape", shape: "rect", x: 0, y: 0, w: 20, h: 10, rotate: 30 },
			{
				type: "polygon",
				points: [
					[0, 0],
					[10, 0],
					[10, 10],
				],
				rotate: 45,
				origin: [5, 5],
			},
		]);
		expect(
			container.querySelector("g[transform]")?.getAttribute("transform"),
		).toBe("rotate(-30 10 5)");
		expect(container.querySelector("polygon")?.getAttribute("transform")).toBe(
			"rotate(-45 5 5)",
		);
	});

	it("polygon は origin 省略時に外接矩形の中心で回る", () => {
		const { container } = renderDiagram([
			{
				type: "polygon",
				points: [
					[0, 0],
					[20, 0],
					[20, 10],
				],
				rotate: 90,
			},
		]);
		expect(container.querySelector("polygon")?.getAttribute("transform")).toBe(
			"rotate(-90 10 5)",
		);
		expect(container.querySelector("polygon")?.getAttribute("points")).toBe(
			"0,0 20,0 20,10",
		);
	});

	it("polyline は dashed で破線になる", () => {
		const { container } = renderDiagram([
			{
				type: "polyline",
				points: [
					[0, 0],
					[10, 10],
					[20, 0],
				],
				dashed: true,
			},
		]);
		expect(
			container.querySelector("polyline")?.getAttribute("stroke-dasharray"),
		).toBeTruthy();
	});

	it("arrow だけが矢じりを持ち、line は持たない", () => {
		const { container } = renderDiagram([
			{ type: "arrow", x1: 10, y1: 10, x2: 40, y2: 10, color: "accent" },
			{ type: "line", x1: 10, y1: 20, x2: 40, y2: 20 },
		]);
		const lines = container.querySelectorAll("line");
		const markerEnd = lines[0]?.getAttribute("marker-end");
		expect(markerEnd).toMatch(/^url\(#.+\)$/);
		expect(lines[1]?.getAttribute("marker-end")).toBeNull();
		const id = markerEnd?.slice(5, -1) ?? "";
		const marker = container.querySelector("marker");
		expect(marker?.getAttribute("id")).toBe(id);
		expect(id).not.toContain(":");
		expect(marker?.querySelector("path")?.getAttribute("fill")).toContain(
			"--ds-accent",
		);
	});

	it("矢じりの id は図ごとに衝突しない", () => {
		const arrow: DiagramElement = {
			type: "arrow",
			x1: 0,
			y1: 0,
			x2: 10,
			y2: 0,
		};
		const { container } = render(
			<>
				<Diagram elements={[arrow]} />
				<Diagram elements={[arrow]} />
			</>,
		);
		const ids = [...container.querySelectorAll("marker")].map((m) => m.id);
		expect(ids).toHaveLength(2);
		expect(new Set(ids).size).toBe(2);
	});

	it("line のラベルは線の上側に置く", () => {
		renderDiagram([
			{ type: "arrow", x1: 10, y1: 30, x2: 50, y2: 30, label: "揚力" },
		]);
		const text = screen.getByText("揚力");
		expect(text.getAttribute("x")).toBe("30");
		expect(Number(text.getAttribute("y"))).toBeLessThan(30);
	});

	it("label は size と align を反映する", () => {
		renderDiagram([
			{ type: "label", x: 5, y: 5, text: "小", size: "sm", align: "start" },
			{ type: "label", x: 5, y: 15, text: "大", size: "lg", align: "end" },
		]);
		const small = screen.getByText("小");
		const large = screen.getByText("大");
		expect(small.getAttribute("text-anchor")).toBe("start");
		expect(large.getAttribute("text-anchor")).toBe("end");
		expect(Number(large.getAttribute("font-size"))).toBeGreaterThan(
			Number(small.getAttribute("font-size")),
		);
	});

	it("color は既定が ink で、accent は --ds-accent を経由する", () => {
		renderDiagram([
			{ type: "label", x: 1, y: 1, text: "a" },
			{ type: "label", x: 1, y: 5, text: "b", color: "accent" },
			{ type: "label", x: 1, y: 9, text: "c", color: "positive" },
			{ type: "label", x: 1, y: 13, text: "d", color: "negative" },
			{ type: "label", x: 1, y: 17, text: "e", color: "warning" },
			{ type: "label", x: 1, y: 21, text: "f", color: "muted" },
		]);
		const fill = (t: string) => screen.getByText(t).getAttribute("fill");
		expect(fill("a")).toBe("var(--foreground)");
		expect(fill("b")).toBe("var(--ds-accent, var(--primary))");
		expect(fill("c")).toBe("var(--success)");
		expect(fill("d")).toBe("var(--destructive)");
		expect(fill("e")).toBe("var(--warning)");
		expect(fill("f")).toBe("var(--muted-foreground)");
	});

	it("visible が false の要素は描かず、aria の要約にも含めない", () => {
		const { container } = renderDiagram([
			{ type: "label", x: 1, y: 1, text: "出す" },
			{ type: "label", x: 1, y: 9, text: "隠す", visible: false },
		]);
		expect(screen.queryByText("隠す")).not.toBeInTheDocument();
		expect(elementsOf(container, "label")).toHaveLength(1);
		expect(screen.getByRole("img").getAttribute("aria-label")).not.toContain(
			"隠す",
		);
	});

	it("highlighted の要素は太線と強調属性を持つ", () => {
		const { container } = renderDiagram([
			{ type: "line", x1: 0, y1: 0, x2: 10, y2: 0 },
			{ type: "line", x1: 0, y1: 5, x2: 10, y2: 5, highlighted: true },
		]);
		const [plain, strong] = container.querySelectorAll("line");
		expect(Number(strong?.getAttribute("stroke-width"))).toBeGreaterThan(
			Number(plain?.getAttribute("stroke-width")),
		);
		const groups = container.querySelectorAll("[data-diagram-element]");
		expect(groups[0]?.getAttribute("data-highlighted")).toBeNull();
		expect(groups[1]?.getAttribute("data-highlighted")).toBe("true");
	});

	it("非有限の数値を持つ要素は描かず、ほかの要素は描く", () => {
		const { container } = renderDiagram([
			{ type: "arrow", x1: 0, y1: 0, x2: Number.NaN, y2: 0 },
			{
				type: "shape",
				shape: "rect",
				x: 0,
				y: 0,
				w: Number.POSITIVE_INFINITY,
				h: 5,
			},
			{
				type: "polygon",
				points: [
					[0, 0],
					[10, 0],
					[Number.NaN, 5],
				],
			},
			{ type: "angle", x: 50, y: 50, from: 0, to: 60, radius: Number.NaN },
			{ type: "label", x: Number.NaN, y: 1, text: "ずれ" },
			{ type: "label", x: 1, y: 1, text: "残る" },
		]);
		expect(container.querySelectorAll("[data-diagram-element]")).toHaveLength(
			1,
		);
		expect(screen.getByText("残る")).toBeInTheDocument();
		expect(screen.queryByText("ずれ")).not.toBeInTheDocument();
		expect(container.querySelector("marker")).toBeNull();
	});

	it("angle は反時計回りの弧を描く（y は反転）", () => {
		const { container } = renderDiagram([
			{ type: "angle", x: 50, y: 50, from: 0, to: 60, radius: 10, label: "θ" },
		]);
		const path = container.querySelector("path");
		expect(path?.getAttribute("data-angle-kind")).toBe("arc");
		// 0 度は頂点の右、60 度は右上（y が小さくなる）へ向かい、sweep-flag は 0（反時計回り）。
		expect(path?.getAttribute("d")).toBe("M 60 50 A 10 10 0 0 0 55 41.34");
		const label = screen.getByText("θ");
		expect(Number(label.getAttribute("x"))).toBeGreaterThan(50);
		expect(Number(label.getAttribute("y"))).toBeLessThan(50);
	});

	it("angle は from を超えて 0 度をまたぐ弧と、180 度を超える large-arc を扱う", () => {
		const { container } = renderDiagram([
			{ type: "angle", x: 50, y: 50, from: 350, to: 20, radius: 10 },
			{ type: "angle", x: 50, y: 50, from: 0, to: 270, radius: 10 },
		]);
		const [wrap, big] = container.querySelectorAll("path");
		// 350 → 20 は 30 度の弧（large-arc は 0）。
		expect(wrap?.getAttribute("d")).toMatch(/ A 10 10 0 0 0 /);
		expect(big?.getAttribute("d")).toMatch(/ A 10 10 0 1 0 /);
	});

	it("angle が 90 度のときは直角記号を描く", () => {
		const { container } = renderDiagram([
			{ type: "angle", x: 50, y: 50, from: 0, to: 90, radius: 10 },
		]);
		const path = container.querySelector("path");
		expect(path?.getAttribute("data-angle-kind")).toBe("right");
		expect(path?.getAttribute("d")).toBe("M 56 50 L 56 44 L 50 44");
	});

	it("from と to が同じ angle は描かない", () => {
		const { container } = renderDiagram([
			{ type: "angle", x: 50, y: 50, from: 30, to: 30, radius: 10, label: "θ" },
		]);
		expect(container.querySelector("path")).toBeNull();
		expect(screen.queryByText("θ")).not.toBeInTheDocument();
	});

	it("title と caption を表示し、svg に role=img と要約の aria-label を付ける", () => {
		renderDiagram(
			[
				{ type: "arrow", x1: 10, y1: 10, x2: 40, y2: 10, label: "揚力" },
				{ type: "label", x: 50, y: 20, text: "重力" },
				{ type: "shape", shape: "rect", x: 0, y: 0, w: 5, h: 5 },
			],
			{ title: "飛行機に働く力", caption: "迎角が増えると揚力が増える" },
		);
		expect(screen.getByText("飛行機に働く力")).toBeInTheDocument();
		expect(screen.getByText("迎角が増えると揚力が増える")).toBeInTheDocument();
		const svg = screen.getByRole("img", { name: /飛行機に働く力/ });
		expect(svg.getAttribute("aria-label")).toBe("飛行機に働く力: 揚力、重力");
	});

	it("title がなければ「図解」で要約し、長い要約は切り詰める", () => {
		renderDiagram(
			Array.from({ length: 60 }, (_, i) => ({
				type: "label" as const,
				x: 1,
				y: 1,
				text: `ラベル${i}`,
			})),
		);
		const label = screen.getByRole("img").getAttribute("aria-label") ?? "";
		expect(label.startsWith("図解: ")).toBe(true);
		expect(label.length).toBeLessThanOrEqual(240);
	});
});
