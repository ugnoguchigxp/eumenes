import { render, screen } from "@testing-library/react";
import katex from "katex";
import { describe, expect, it, vi } from "vitest";
import { Formula, renderFormula } from "./Formula";

describe("Formula", () => {
	it("KaTeX で数式を描画する", () => {
		const { container } = render(<Formula tex="E = mc^2" />);
		expect(container.querySelector(".katex")).toBeInTheDocument();
		expect(container.querySelector(".katex-mathml")).toBeInTheDocument();
		expect(container.querySelector("annotation")).toHaveTextContent("E = mc^2");
	});

	it("見出し、値、注記を併記する", () => {
		render(
			<Formula
				label="ステップ2"
				tex="d = v t"
				value="= 384,400 km"
				caption="月までの距離"
			/>,
		);
		expect(screen.getByText("ステップ2")).toBeInTheDocument();
		expect(screen.getByText("= 384,400 km")).toBeInTheDocument();
		expect(screen.getByText("月までの距離")).toBeInTheDocument();
	});

	it.each([
		"\\href{https://example.com}{link}",
		"\\href{javascript:alert(1)}{x}",
		"\\url{https://example.com}",
		"\\includegraphics{https://example.com/a.png}",
		"\\htmlClass{evil}{x}",
		"\\htmlId{evil}{x}",
		"\\htmlStyle{color:red}{x}",
		"\\htmlData{k=v}{x}",
	])("信頼しない入力 %s を無効にする", (tex) => {
		const doc = document.createElement("div");
		doc.innerHTML = renderFormula(tex).html;
		// The TeX source stays only as text in <annotation>; nothing it asks for is created.
		expect(
			doc.querySelector("a, img, [href], [src], [id], [data-k]"),
		).toBeNull();
		expect(doc.querySelector(".evil")).toBeNull();
		expect(doc.innerHTML).not.toMatch(/style="[^"]*color:red/);
	});

	it("リンクを描画しない", () => {
		const { container } = render(
			<Formula tex={"\\href{https://example.com}{x}"} />,
		);
		expect(container.querySelector("a")).toBeNull();
		expect(container.querySelector("img")).toBeNull();
	});

	it("マクロの無限展開を止めて表示できない旨を出す", () => {
		render(<Formula tex={"\\def\\a{\\a\\a}\\a"} />);
		expect(screen.getByRole("alert")).toHaveTextContent("数式を表示できません");
	});

	it("構文エラーを例外にせず表示できない旨を出す", () => {
		render(<Formula tex={"\\frac{1"} value="= 1" />);
		expect(screen.getByRole("alert")).toHaveTextContent("数式を表示できません");
		expect(screen.getByText("= 1")).toBeInTheDocument();
	});

	it("本文の HTML を挿入しない", () => {
		const { container } = render(
			<Formula tex={'x<img src=x onerror="alert(1)">'} />,
		);
		expect(container.querySelector("img")).toBeNull();
	});

	it("未定義のコマンドは赤字で描かず表示できない旨にする", () => {
		render(<Formula tex={"\\nosuchcommand{x}"} />);
		expect(screen.getByRole("alert")).toHaveTextContent("数式を表示できません");
	});

	it("無効にした \\href もフォールバックにする", () => {
		render(<Formula tex={"\\href{https://example.com}{x}"} />);
		expect(screen.getByRole("alert")).toHaveTextContent("数式を表示できません");
	});

	it("KaTeX が例外を投げても描画全体を落とさない", () => {
		const spy = vi.spyOn(katex, "renderToString").mockImplementation(() => {
			throw new Error("boom");
		});
		render(<Formula tex="x" value="= 1" />);
		expect(screen.getByRole("alert")).toHaveTextContent("数式を表示できません");
		expect(screen.getByText("= 1")).toBeInTheDocument();
		spy.mockRestore();
	});
});
