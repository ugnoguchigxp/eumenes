import type { Meta, StoryObj } from "@storybook/react-vite";
import { Hero } from "./Hero";

const meta: Meta<typeof Hero> = {
	title: "Components/Hero",
	component: Hero,
	tags: ["autodocs"],
	args: {
		eyebrow: "新登場",
		title: "毎朝の一杯を、ていねいに",
		body: "産地ごとに焙煎した豆を、注文を受けてからお届けします。",
		primaryLabel: "商品を見る",
		secondaryLabel: "ご利用ガイド",
	},
};
export default meta;
type Story = StoryObj<typeof Hero>;
export const Centered: Story = { args: { variant: "centered" } };
export const CenteredWithImage: Story = {
	args: {
		variant: "centered",
		image: { placeholder: "warm", alt: "焙煎した豆" },
	},
};
export const Split: Story = {
	args: {
		variant: "split",
		image: { placeholder: "accent", alt: "店内の様子" },
	},
};
export const BackgroundDark: Story = {
	args: {
		variant: "background",
		overlay: "dark",
		align: "center",
		height: "md",
		image: { placeholder: "cool", alt: "湖畔" },
	},
};
export const BackgroundLight: Story = {
	args: {
		variant: "background",
		overlay: "light",
		align: "start",
		height: "lg",
		image: { placeholder: "warm", alt: "朝の食卓" },
	},
};
export const BackgroundAccent: Story = {
	args: {
		variant: "background",
		overlay: "accent",
		align: "start",
		image: { placeholder: "neutral", alt: "街並み" },
	},
};
export const ImageLoadFailed: Story = {
	args: {
		variant: "split",
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
			<Hero
				{...args}
				variant="split"
				image={{ placeholder: "accent", alt: "店内" }}
			/>
		</div>
	),
};
