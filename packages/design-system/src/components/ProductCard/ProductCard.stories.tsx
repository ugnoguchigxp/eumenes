import type { Meta, StoryObj } from "@storybook/react-vite";
import { ProductCard } from "./ProductCard";

const meta: Meta<typeof ProductCard> = {
	title: "Components/ProductCard",
	component: ProductCard,
	tags: ["autodocs"],
	args: {
		image: { placeholder: "warm", alt: "珈琲豆の袋" },
		name: "ハンドドリップ珈琲 200g",
		price: "¥1,800",
		body: "深煎りのブレンドです。",
		rating: 4.5,
	},
	decorators: [
		(Story) => (
			<div style={{ maxWidth: 360 }}>
				<Story />
			</div>
		),
	],
};
export default meta;
type Story = StoryObj<typeof ProductCard>;
export const Vertical: Story = {};
export const Horizontal: Story = {
	args: { variant: "horizontal" },
	decorators: [
		(Story) => (
			<div style={{ maxWidth: 560 }}>
				<Story />
			</div>
		),
	],
};
export const New: Story = { args: { badge: "new" } };
export const Sale: Story = {
	args: { badge: "sale", price: "¥1,800", compareAtPrice: "¥2,400" },
};
export const Limited: Story = { args: { badge: "limited" } };
export const SoldOut: Story = { args: { badge: "soldout" } };
export const WithoutImage: Story = { args: { image: undefined } };
export const ImageLoadFailed: Story = {
	args: {
		image: {
			src: "https://invalid.example/missing.jpg",
			alt: "読み込めない写真",
		},
	},
};
export const Dark: Story = {
	render: (args) => (
		<div
			className="ds-theme-dark"
			style={{
				background: "var(--background)",
				color: "var(--foreground)",
				padding: 16,
			}}
		>
			<ProductCard {...args} badge="sale" compareAtPrice="¥2,400" />
		</div>
	),
};
