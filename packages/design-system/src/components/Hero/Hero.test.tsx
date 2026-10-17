import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { Hero } from "./Hero";

afterEach(cleanup);

it("shows the heading, text and display-only labels", () => {
	render(
		<Hero
			eyebrow="新登場"
			title="はじめての珈琲"
			body="毎朝の一杯を、ていねいに。"
			primaryLabel="詳しく見る"
			secondaryLabel="資料を請求"
		/>,
	);
	expect(
		screen.getByRole("heading", { level: 2, name: "はじめての珈琲" }),
	).toBeInTheDocument();
	expect(screen.getByText("新登場")).toBeInTheDocument();
	expect(screen.getByText("毎朝の一杯を、ていねいに。")).toBeInTheDocument();
	expect(screen.getByText("詳しく見る")).toBeInTheDocument();
	expect(screen.getByText("資料を請求")).toBeInTheDocument();
	expect(screen.queryByRole("button")).toBeNull();
	expect(screen.queryByRole("link")).toBeNull();
});

it("defaults to centered and omits the image and actions when absent", () => {
	const { container } = render(<Hero title="タイトル" />);
	expect(container.querySelector("section")).toHaveAttribute(
		"data-variant",
		"centered",
	);
	expect(container.querySelector(".ds-hero-actions")).toBeNull();
	expect(container.querySelector(".ds-content-image")).toBeNull();
});

it("lays text and image side by side for split", () => {
	const { container } = render(
		<Hero
			variant="split"
			title="分割"
			image={{ src: "https://example.com/x.jpg", alt: "店内の様子" }}
		/>,
	);
	expect(container.querySelector("section")).toHaveAttribute(
		"data-variant",
		"split",
	);
	expect(screen.getByRole("img", { name: "店内の様子" })).toBeInTheDocument();
});

it("puts text over a backdrop with the chosen overlay, align and height", () => {
	const { container } = render(
		<Hero
			variant="background"
			title="背景"
			overlay="light"
			align="start"
			height="lg"
			image={{ src: "https://example.com/x.jpg", alt: "海辺" }}
		/>,
	);
	const section = container.querySelector("section");
	expect(section).toHaveAttribute("data-overlay", "light");
	expect(section).toHaveAttribute("data-align", "start");
	expect(section).toHaveAttribute("data-height", "lg");
	expect(container.querySelector(".ds-hero-overlay")).toHaveAttribute(
		"aria-hidden",
		"true",
	);
	expect(screen.getByRole("heading", { name: "背景" })).toBeInTheDocument();
});

it("falls back to a placeholder backdrop when the image fails", () => {
	const { container } = render(
		<Hero
			variant="background"
			title="背景"
			image={{ src: "https://example.com/missing.jpg", alt: "海辺" }}
		/>,
	);
	fireEvent.error(container.querySelector("img") as HTMLImageElement);
	expect(screen.getByRole("img", { name: "海辺" })).toHaveAttribute(
		"data-placeholder",
	);
	expect(screen.getByRole("heading", { name: "背景" })).toBeInTheDocument();
});

it("uses an accent placeholder backdrop when there is no image", () => {
	const { container } = render(<Hero variant="background" title="背景" />);
	expect(container.querySelector("[data-placeholder='accent']")).not.toBeNull();
});
