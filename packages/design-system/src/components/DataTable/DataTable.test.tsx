import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DataTable } from "./DataTable";

const columns = [{ header: "都市" }, { header: "人口" }];
const rows = [
	["東京", 13960000],
	["大阪", 8840000],
];

describe("DataTable", () => {
	it("見出しと行を表にする", () => {
		render(<DataTable title="人口" columns={columns} rows={rows} />);
		expect(screen.getByRole("table", { name: "人口" })).toBeInTheDocument();
		expect(
			screen.getAllByRole("columnheader").map((c) => c.textContent),
		).toEqual(["都市", "人口"]);
		const body = screen.getAllByRole("row").slice(1);
		expect(
			within(body[0] as HTMLElement)
				.getAllByRole("cell")
				.map((c) => c.textContent),
		).toEqual(["東京", "13,960,000"]);
	});

	it("数値の列だけを右寄せにする", () => {
		render(<DataTable columns={columns} rows={rows} />);
		const cells = screen.getAllByRole("cell");
		expect(cells[0]).toHaveClass("text-left");
		expect(cells[1]).toHaveClass("text-right");
	});

	it("align を優先し、formatNumber で数値を整える", () => {
		render(
			<DataTable
				columns={[{ header: "都市", align: "center" }, { header: "人口" }]}
				rows={rows}
				formatNumber={(n) => `${n / 10000}万人`}
			/>,
		);
		expect(screen.getAllByRole("cell")[0]).toHaveClass("text-center");
		expect(screen.getByText("1396万人")).toBeInTheDocument();
	});

	it("省いた行数を「他N行」と示す", () => {
		render(<DataTable columns={columns} rows={rows} omittedRows={198} />);
		expect(screen.getByText("他198行")).toBeInTheDocument();
	});

	it("行が無いときは「データがありません」を出す", () => {
		render(<DataTable columns={columns} rows={[]} />);
		expect(screen.getByText("データがありません")).toBeInTheDocument();
	});
});
