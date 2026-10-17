import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { PricingCard } from "./PricingCard";

afterEach(cleanup);

it("shows plan, price, period, body, features and a display-only button", () => {
	render(
		<PricingCard
			plan="スタンダード"
			price="¥1,200"
			period="月"
			body="基本のプラン"
			features={["機能A", "機能B"]}
			ctaLabel="選ぶ"
		/>,
	);
	expect(
		screen.getByRole("heading", { name: "スタンダード" }),
	).toBeInTheDocument();
	expect(screen.getByText("¥1,200")).toBeInTheDocument();
	expect(screen.getByText("/ 月")).toBeInTheDocument();
	expect(screen.getByText("基本のプラン")).toBeInTheDocument();
	expect(screen.getAllByRole("listitem")).toHaveLength(2);
	expect(screen.queryByText("おすすめ")).not.toBeInTheDocument();
	const button = screen.getByRole("button", { name: "選ぶ" });
	expect(button).toHaveAttribute("type", "button");
	expect(() => fireEvent.click(button)).not.toThrow();
});

it("marks the highlighted plan as recommended", () => {
	const { container } = render(
		<PricingCard plan="プロ" price="¥4,800" features={["機能"]} highlighted />,
	);
	expect(screen.getByText("おすすめ")).toBeInTheDocument();
	expect(container.firstElementChild).toHaveAttribute(
		"data-highlighted",
		"true",
	);
});

it("omits optional parts and the button when not given", () => {
	render(<PricingCard plan="フリー" price="¥0" features={["基本"]} />);
	expect(screen.queryByRole("button")).not.toBeInTheDocument();
	expect(screen.queryByText(/^\//)).not.toBeInTheDocument();
});
