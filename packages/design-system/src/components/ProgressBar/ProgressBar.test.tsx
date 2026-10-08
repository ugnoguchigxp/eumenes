import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProgressBar } from "./ProgressBar";

describe("ProgressBar", () => {
	it("renders with default props", () => {
		render(<ProgressBar value={50} />);
		const progress = screen.getByRole("progressbar");
		expect(progress).toBeInTheDocument();
		expect(progress).toHaveAttribute("aria-valuenow", "50");
		// Default height uses CSS variable
		expect(progress).toHaveClass("h-[var(--ui-progress-height)]");
	});

	it("renders with label and subLabel", () => {
		render(<ProgressBar value={50} label="Progress" subLabel="Halfway" />);
		expect(screen.getByText("Progress")).toBeInTheDocument();
		expect(screen.getByText("Halfway")).toBeInTheDocument();
	});

	it("clamps value between 0 and 100", () => {
		const { rerender } = render(<ProgressBar value={150} />);
		expect(screen.getByRole("progressbar")).toHaveAttribute(
			"aria-valuenow",
			"100",
		);

		const indicator = screen.getByRole("progressbar").firstElementChild;
		// 150 clamped to 100 -> translateX(0%)
		expect(indicator).toHaveStyle({ transform: "translateX(-0%)" });

		rerender(<ProgressBar value={-20} />);
		expect(screen.getByRole("progressbar")).toHaveAttribute(
			"aria-valuenow",
			"0",
		);
		// -20 clamped to 0 -> translateX(-100%)
		expect(indicator).toHaveStyle({ transform: "translateX(-100%)" });
	});

	it("applies custom color", () => {
		render(<ProgressBar value={50} color="bg-purple-500" />);
		const indicator = screen
			.getByRole("progressbar")
			.querySelector(".bg-purple-500");
		expect(indicator).toBeInTheDocument();
	});

	it("applies status-based colors", () => {
		const { rerender } = render(<ProgressBar value={50} status="paused" />);
		let indicator = screen.getByRole("progressbar").firstElementChild;
		expect(indicator).toHaveClass("bg-yellow-500");

		rerender(<ProgressBar value={50} status="error" />);
		indicator = screen.getByRole("progressbar").firstElementChild;
		expect(indicator).toHaveClass("bg-red-800");
	});

	it("interpolates color for normal status", () => {
		render(<ProgressBar value={50} status="normal" />);
		const indicator = screen.getByRole("progressbar")
			.firstElementChild as HTMLElement;
		// 50% is Blue: rgb(37, 99, 235)
		expect(indicator.style.backgroundColor).toContain("rgb(37, 99, 235)");
	});

	it("renders striped and animated by default", () => {
		render(<ProgressBar value={50} />);
		const indicator = screen.getByRole("progressbar").firstElementChild;
		expect(indicator).toHaveClass("animate-progress-stripes");
	});

	it("disables animation and stripes", () => {
		render(<ProgressBar value={50} striped={false} animated={false} />);
		const indicator = screen.getByRole("progressbar").firstElementChild;
		expect(indicator).not.toHaveClass("animate-progress-stripes");
		// Check stripe gradient class part (simplified check)
		expect(indicator?.className).not.toContain("linear-gradient");
	});

	it("shows percentage inside bar for sufficient height", () => {
		render(<ProgressBar value={50} height="h-6" />);
		// PercentFormat displays 50%
		expect(screen.getByText("50%")).toBeInTheDocument();
	});

	it("does not show percentage for small height", () => {
		render(<ProgressBar value={50} height="h-2" />);
		expect(screen.queryByText("50%")).not.toBeInTheDocument();
	});
});

it("custom maximum keeps the visible percent and accessible value consistent", () => {
	render(<ProgressBar value={50} max={200} />);
	const progress = screen.getByRole("progressbar");
	expect(progress).toHaveAttribute("aria-valuenow", "50");
	expect(progress).toHaveAttribute("aria-valuemax", "200");
	expect(progress.firstElementChild).toHaveStyle({
		transform: "translateX(-75%)",
	});
});
