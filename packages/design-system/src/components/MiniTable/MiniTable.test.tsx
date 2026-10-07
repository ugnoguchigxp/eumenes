import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MiniTable } from "./MiniTable";

describe("MiniTable Component", () => {
	const columns = [
		{ key: "name", label: "Name", width: "2fr" },
		{ key: "role", label: "Role", align: "center" as const, width: "1fr" },
		{ key: "status", label: "Status", align: "right" as const },
	];

	const rows = [
		{
			key: "1",
			cells: {
				name: <span>User 1</span>,
				role: "Admin",
				status: "Active",
			},
		},
		{
			key: "2",
			cells: {
				name: "User 2",
				role: "Editor",
				status: "Inactive",
			},
		},
	];

	it("renders columns and rows", () => {
		render(<MiniTable columns={columns} rows={rows} />);

		// Headers
		expect(screen.getByText("Name")).toBeInTheDocument();
		expect(screen.getByText("Role")).toBeInTheDocument();
		expect(screen.getByText("Status")).toBeInTheDocument();

		// Rows
		expect(screen.getByText("User 1")).toBeInTheDocument();
		expect(screen.getByText("Admin")).toBeInTheDocument();
		expect(screen.getByText("Active")).toBeInTheDocument();
		expect(screen.getByText("User 2")).toBeInTheDocument();
	});

	it("hides header when hideHeader is true", () => {
		render(<MiniTable columns={columns} rows={rows} hideHeader />);

		expect(screen.queryByText("Name")).not.toBeInTheDocument();
		expect(screen.getByText("User 1")).toBeInTheDocument();
	});

	it("applies styles for alignment and width", () => {
		const { container } = render(<MiniTable columns={columns} rows={rows} />);

		// Check grid layout
		const gridDiv = container.querySelector(".grid");
		expect(gridDiv).toHaveStyle("grid-template-columns: 2fr 1fr 1fr");

		// Check Alignment (Admin is center)
		const adminCell = screen.getByText("Admin").closest("div");
		expect(adminCell).toHaveStyle("text-align: center");

		// Check Alignment (Active is right)
		const activeCell = screen.getByText("Active").closest("div");
		expect(activeCell).toHaveStyle("text-align: right");
	});

	it("applies custom header background", () => {
		render(<MiniTable columns={columns} rows={rows} headerBg="bg-blue-500" />);

		const headerCell = screen.getByText("Name").closest("div");
		expect(headerCell).toHaveClass("bg-blue-500");
	});
});
