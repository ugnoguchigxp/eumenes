import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ProductCard } from "./ProductCard";

afterEach(cleanup);

it("shows name, price and the struck-through regular price with labels", () => {
	const { container } = render(
		<ProductCard
			name="ハンドドリップ珈琲 200g"
			price="¥1,800"
			compareAtPrice="¥2,400"
			body="深煎りのブレンドです。"
		/>,
	);
	expect(
		screen.getByRole("heading", { level: 3, name: "ハンドドリップ珈琲 200g" }),
	).toBeInTheDocument();
	expect(screen.getByText("¥1,800")).toBeInTheDocument();
	const compare = container.querySelector("s");
	expect(compare).toHaveTextContent("¥2,400");
	expect(compare).toHaveTextContent("通常価格");
	expect(screen.getByText("深煎りのブレンドです。")).toBeInTheDocument();
});

it.each([
	["new", "新着"],
	["sale", "セール"],
	["limited", "限定"],
	["soldout", "売り切れ"],
] as const)("shows the %s badge in Japanese", (badge, label) => {
	const { container } = render(<ProductCard name="商品" badge={badge} />);
	expect(screen.getByText(label)).toHaveAttribute("data-badge", badge);
	expect(container.querySelector("article")).toHaveAttribute(
		"data-soldout",
		String(badge === "soldout"),
	);
});

it("exposes the rating to screen readers and rounds to half steps", () => {
	const { container, rerender } = render(
		<ProductCard name="商品" rating={4.5} />,
	);
	expect(screen.getByText("5点満点中4.5点")).toBeInTheDocument();
	expect(container.querySelectorAll(".ds-product-card-star")).toHaveLength(5);
	expect(container.querySelectorAll(".ds-product-card-star-fill")).toHaveLength(
		5,
	);
	rerender(<ProductCard name="商品" rating={3.8} />);
	expect(screen.getByText("5点満点中4点")).toBeInTheDocument();
	rerender(<ProductCard name="商品" rating={9} />);
	expect(screen.getByText("5点満点中5点")).toBeInTheDocument();
	rerender(<ProductCard name="商品" rating={0} />);
	expect(screen.getByText("5点満点中0点")).toBeInTheDocument();
	expect(container.querySelectorAll(".ds-product-card-star-fill")).toHaveLength(
		0,
	);
	rerender(<ProductCard name="商品" />);
	expect(screen.queryByText(/5点満点/)).toBeNull();
});

it("renders the image, and falls back to a placeholder on failure", () => {
	const { container } = render(
		<ProductCard
			name="商品"
			image={{ src: "https://example.com/p.jpg", alt: "商品写真" }}
		/>,
	);
	fireEvent.error(container.querySelector("img") as HTMLImageElement);
	expect(screen.getByRole("img", { name: "商品写真" })).toHaveAttribute(
		"data-placeholder",
	);
});

it("switches variant and has no interactive elements", () => {
	render(<ProductCard name="商品" variant="horizontal" price="¥100" />);
	expect(screen.getByRole("article")).toHaveAttribute(
		"data-variant",
		"horizontal",
	);
	expect(screen.queryByRole("button")).toBeNull();
	expect(screen.queryByRole("link")).toBeNull();
});
