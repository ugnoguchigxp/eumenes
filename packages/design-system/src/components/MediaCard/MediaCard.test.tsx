import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { MediaCard } from "./MediaCard";

afterEach(cleanup);

it("shows eyebrow, a heading and body next to the image", () => {
	render(
		<MediaCard
			image={{ src: "https://example.com/a.jpg", alt: "畑の風景" }}
			eyebrow="特集"
			title="畑から食卓へ"
			body="契約農家から届く旬の野菜です。"
		/>,
	);
	expect(screen.getByRole("article")).toBeInTheDocument();
	expect(
		screen.getByRole("heading", { level: 3, name: "畑から食卓へ" }),
	).toBeInTheDocument();
	expect(screen.getByText("特集")).toBeInTheDocument();
	expect(
		screen.getByText("契約農家から届く旬の野菜です。"),
	).toBeInTheDocument();
	expect(screen.getByRole("img", { name: "畑の風景" })).toBeInTheDocument();
});

it("defaults to vertical and switches to horizontal", () => {
	const { rerender } = render(
		<MediaCard image={{ placeholder: "cool" }} title="縦" />,
	);
	expect(screen.getByRole("article")).toHaveAttribute(
		"data-variant",
		"vertical",
	);
	rerender(
		<MediaCard
			image={{ placeholder: "cool" }}
			title="横"
			variant="horizontal"
		/>,
	);
	expect(screen.getByRole("article")).toHaveAttribute(
		"data-variant",
		"horizontal",
	);
});

it("passes the aspect to the image frame", () => {
	const { container } = render(
		<MediaCard image={{ placeholder: "warm" }} title="t" aspect="portrait" />,
	);
	expect(container.querySelector(".ds-content-image-frame")).toHaveAttribute(
		"data-aspect",
		"portrait",
	);
});

it("keeps the card layout when the image fails", () => {
	const { container } = render(
		<MediaCard
			image={{ src: "https://example.com/x.jpg", alt: "写真" }}
			title="見出し"
		/>,
	);
	fireEvent.error(container.querySelector("img") as HTMLImageElement);
	expect(screen.getByRole("img", { name: "写真" })).toHaveAttribute(
		"data-placeholder",
	);
	expect(screen.getByRole("heading", { name: "見出し" })).toBeInTheDocument();
});
