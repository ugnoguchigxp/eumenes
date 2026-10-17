import type { Meta, StoryObj } from "@storybook/react-vite";
import { CtaBanner } from "./CtaBanner";

const meta: Meta<typeof CtaBanner> = {
	title: "Components/CtaBanner",
	component: CtaBanner,
	tags: ["autodocs"],
	args: {
		title: "今すぐはじめましょう",
		body: "初月は無料でお試しいただけます。いつでも解約できます。",
		primaryLabel: "無料で試す",
		secondaryLabel: "料金を見る",
	},
};
export default meta;
type Story = StoryObj<typeof CtaBanner>;
export const Accent: Story = { args: { variant: "accent" } };
export const Subtle: Story = { args: { variant: "subtle" } };
export const WithImage: Story = {
	args: { variant: "image", image: { placeholder: "cool", alt: "海辺の朝" } },
};
export const ImageLoadFailed: Story = {
	args: {
		variant: "image",
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
				display: "grid",
				gap: 16,
			}}
		>
			<CtaBanner {...args} variant="accent" />
			<CtaBanner {...args} variant="subtle" />
		</div>
	),
};
