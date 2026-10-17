import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { FeatureCard, featureCardIconNames } from "./FeatureCard";

afterEach(cleanup);

it("shows a heading, body and a decorative icon", () => {
	const { container } = render(
		<FeatureCard
			icon="truck"
			title="全国送料無料"
			body="3,000円以上のご注文で無料です。"
		/>,
	);
	expect(
		screen.getByRole("heading", { level: 3, name: "全国送料無料" }),
	).toBeInTheDocument();
	expect(
		screen.getByText("3,000円以上のご注文で無料です。"),
	).toBeInTheDocument();
	expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
});

it("renders without icon or body", () => {
	const { container } = render(<FeatureCard title="タイトルのみ" />);
	expect(container.querySelector("svg")).toBeNull();
	expect(container.querySelector("p")).toBeNull();
});

it("renders an icon for every name", () => {
	for (const name of featureCardIconNames) {
		const { container, unmount } = render(
			<FeatureCard icon={name} title={name} />,
		);
		expect(container.querySelector("svg"), name).not.toBeNull();
		unmount();
	}
});
