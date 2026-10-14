import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ServerDataTable } from "./ServerDataTable";

afterEach(cleanup);
test("manual sorting/search/pagination emit API conditions without sorting or filtering the supplied page", () => {
	const query = {
		pageIndex: 1,
		pageSize: 10,
		sort: "label",
		desc: false,
		q: "",
	};
	const send = vi.fn();
	const data = [
		{ id: "z", label: "Z" },
		{ id: "a", label: "A" },
	];
	const columns = [
		{
			id: "label",
			header: "名称",
			accessorFn: (r: (typeof data)[number]) => r.label,
		},
	];
	const props = {
		label: "試験",
		rows: data,
		columns,
		query,
		total: 30,
		onQuery: send,
		detail: (r: (typeof data)[number]) => <p>{r.id}の本文</p>,
	};
	const view = render(<ServerDataTable {...props} />);
	fireEvent.click(screen.getByRole("button", { name: /名称/ }));
	expect(send).toHaveBeenLastCalledWith({ ...query, pageIndex: 0, desc: true });
	expect(
		screen
			.getAllByRole("cell")
			.filter((el) => ["Z", "A"].includes(el.textContent ?? ""))
			.map((el) => el.textContent),
	).toEqual(["Z", "A"]);
	fireEvent.change(screen.getByRole("searchbox"), {
		target: { value: "other" },
	});
	fireEvent.submit(screen.getByRole("searchbox").closest("form")!);
	expect(send).toHaveBeenLastCalledWith({ ...query, pageIndex: 0, q: "other" });
	expect(screen.getByText("Z")).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "試験の次のページ" }));
	expect(send).toHaveBeenLastCalledWith({ ...query, pageIndex: 2 });
	fireEvent.change(screen.getByLabelText("試験の表示件数"), {
		target: { value: "25" },
	});
	expect(send).toHaveBeenLastCalledWith({
		...query,
		pageIndex: 0,
		pageSize: 25,
	});
	fireEvent.click(screen.getByRole("button", { name: "試験: zの詳細" }));
	expect(screen.getByText("zの本文")).toBeTruthy();
	view.rerender(
		<ServerDataTable {...props} rows={[{ id: "z", label: "新しいZ" }]} />,
	);
	expect(screen.getByText("zの本文")).toBeTruthy();
	view.rerender(
		<ServerDataTable
			{...props}
			rows={[]}
			total={0}
			query={{ ...query, pageIndex: 0, q: "other" }}
		/>,
	);
	expect(screen.getByText("検索条件に一致する記録はありません。")).toBeTruthy();
	expect(screen.queryByText("zの本文")).toBeNull();
});

test("modal detail closes when its row leaves the result page", () => {
	const props = {
		label: "試験",
		rows: [{ id: "a", label: "A" }],
		columns: [
			{
				id: "label",
				header: "名称",
				accessorFn: (row: { id: string; label: string }) => row.label,
			},
		],
		query: { pageIndex: 0, pageSize: 10, sort: "label", desc: false, q: "" },
		total: 1,
		onQuery: () => {},
		detailMode: "modal" as const,
		detail: (row: { id: string; label: string }) => <p>{row.label}の本文</p>,
	};
	const view = render(<ServerDataTable {...props} />);
	fireEvent.click(screen.getByRole("button", { name: "試験: aの詳細" }));
	expect(screen.getByRole("dialog", { name: "試験の詳細" })).toBeTruthy();
	view.rerender(<ServerDataTable {...props} rows={[]} total={0} />);
	expect(screen.queryByRole("dialog")).toBeNull();
	view.rerender(<ServerDataTable {...props} />);
	expect(screen.queryByRole("dialog")).toBeNull();
});
