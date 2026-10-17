import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { Testimonial } from "./Testimonial";

afterEach(cleanup);

it("shows the quote with name and role as a figure", () => {
	const { container } = render(
		<Testimonial
			{...{ role: "会社員" }}
			quote="毎朝の楽しみになりました。"
			name="佐藤 花子"
		/>,
	);
	expect(container.querySelector("figure blockquote")).toHaveTextContent(
		"毎朝の楽しみになりました。",
	);
	expect(screen.getByText("佐藤 花子")).toBeInTheDocument();
	expect(screen.getByText("会社員")).toBeInTheDocument();
});

it("falls back to the initial of the name when there is no avatar", () => {
	const { container } = render(<Testimonial quote="良い" name="佐藤 花子" />);
	const initial = container.querySelector(".ds-testimonial-initial");
	expect(initial).toHaveTextContent("佐");
	expect(initial).toHaveAttribute("aria-hidden", "true");
});

it("renders the avatar image, and returns to the initial when it fails", () => {
	const { container } = render(
		<Testimonial
			quote="良い"
			name="Taro"
			avatar={{ src: "https://example.com/a.jpg", alt: "Taroさん" }}
		/>,
	);
	expect(screen.getByRole("img", { name: "Taroさん" })).toBeInTheDocument();
	fireEvent.error(container.querySelector("img") as HTMLImageElement);
	expect(container.querySelector("img")).toBeNull();
	expect(container.querySelector(".ds-testimonial-initial")).toHaveTextContent(
		"T",
	);
});

it("uses the initial for a placeholder avatar", () => {
	const { container } = render(
		<Testimonial quote="良い" name="Mika" avatar={{ placeholder: "warm" }} />,
	);
	expect(container.querySelector(".ds-testimonial-initial")).toHaveTextContent(
		"M",
	);
});
