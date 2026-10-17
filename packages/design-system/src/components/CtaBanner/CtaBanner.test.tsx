import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { CtaBanner } from "./CtaBanner";

afterEach(cleanup);

it("shows the heading, body and display-only labels", () => {
	render(
		<CtaBanner
			title="今すぐはじめましょう"
			body="初月は無料でお試しいただけます。"
			primaryLabel="無料で試す"
			secondaryLabel="料金を見る"
		/>,
	);
	expect(
		screen.getByRole("heading", { level: 2, name: "今すぐはじめましょう" }),
	).toBeInTheDocument();
	expect(
		screen.getByText("初月は無料でお試しいただけます。"),
	).toBeInTheDocument();
	expect(screen.getByText("無料で試す")).toBeInTheDocument();
	expect(screen.getByText("料金を見る")).toBeInTheDocument();
	expect(screen.queryByRole("button")).toBeNull();
	expect(screen.queryByRole("link")).toBeNull();
});

it("defaults to accent and has no backdrop unless variant is image", () => {
	const { container, rerender } = render(<CtaBanner title="t" />);
	expect(container.querySelector("section")).toHaveAttribute(
		"data-variant",
		"accent",
	);
	expect(container.querySelector(".ds-cta-banner-actions")).toBeNull();
	rerender(
		<CtaBanner
			title="t"
			variant="subtle"
			image={{ src: "https://example.com/a.jpg", alt: "背景" }}
		/>,
	);
	expect(container.querySelector("section")).toHaveAttribute(
		"data-variant",
		"subtle",
	);
	expect(container.querySelector("img")).toBeNull();
});

it("draws the image variant with a backdrop and overlay", () => {
	const { container } = render(
		<CtaBanner
			title="t"
			variant="image"
			image={{ src: "https://example.com/a.jpg", alt: "背景" }}
		/>,
	);
	expect(screen.getByRole("img", { name: "背景" })).toBeInTheDocument();
	expect(container.querySelector(".ds-cta-banner-overlay")).toHaveAttribute(
		"aria-hidden",
		"true",
	);
});

it("falls back to a placeholder backdrop when the image fails or is missing", () => {
	const { container, rerender } = render(
		<CtaBanner
			title="t"
			variant="image"
			image={{ src: "https://example.com/missing.jpg", alt: "背景" }}
		/>,
	);
	fireEvent.error(container.querySelector("img") as HTMLImageElement);
	expect(screen.getByRole("img", { name: "背景" })).toHaveAttribute(
		"data-placeholder",
	);
	rerender(<CtaBanner title="t" variant="image" />);
	expect(container.querySelector("[data-placeholder='accent']")).not.toBeNull();
});
