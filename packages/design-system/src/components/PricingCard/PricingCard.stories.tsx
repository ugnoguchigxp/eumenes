import type { Meta, StoryObj } from "@storybook/react-vite";
import { PricingCard } from "./PricingCard";

const meta: Meta<typeof PricingCard> = {
	title: "Components/PricingCard",
	component: PricingCard,
	tags: ["autodocs"],
};
export default meta;
type Story = StoryObj<typeof PricingCard>;

const base = {
	plan: "スタンダード",
	price: "¥1,200",
	period: "月",
	body: "個人や小さなチームに向いた基本のプランです。",
	features: ["プロジェクト 10 件", "共有メンバー 5 名", "メールサポート"],
	ctaLabel: "このプランを選ぶ",
};

export const Default: Story = { args: base };
export const Highlighted: Story = { args: { ...base, highlighted: true } };
export const Minimal: Story = {
	args: { plan: "フリー", price: "¥0", features: ["基本機能"] },
};
export const Dark: Story = {
	args: { ...base, highlighted: true },
	decorators: [
		(Story) => (
			<div className="ds-theme-dark" style={{ background: "var(--background)", color: "var(--foreground)", padding: "1.5rem" }}>
				<Story />
			</div>
		),
	],
};
export const Row: Story = {
	render: () => (
		<div style={{ display: "grid", gap: "1.5rem", gridTemplateColumns: "repeat(auto-fit, minmax(14rem, 1fr))", paddingTop: "1rem" }}>
			<PricingCard {...base} plan="フリー" price="¥0" ctaLabel="はじめる" />
			<PricingCard {...base} highlighted />
			<PricingCard {...base} plan="プロ" price="¥4,800" features={[...base.features, "優先サポート"]} />
		</div>
	),
};
