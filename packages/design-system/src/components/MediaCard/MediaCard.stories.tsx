import type { Meta, StoryObj } from "@storybook/react-vite";
import { MediaCard } from "./MediaCard";

const meta: Meta<typeof MediaCard> = {
	title: "Components/MediaCard",
	component: MediaCard,
	tags: ["autodocs"],
	args: {
		image: { placeholder: "warm", alt: "畑の風景" },
		eyebrow: "特集",
		title: "畑から食卓へ",
		body: "契約農家から届く旬の野菜を、その日のうちに発送します。",
	},
	decorators: [
		(Story) => (
			<div style={{ maxWidth: 640 }}>
				<Story />
			</div>
		),
	],
};
export default meta;
type Story = StoryObj<typeof MediaCard>;
export const Vertical: Story = { args: { variant: "vertical" } };
export const Horizontal: Story = { args: { variant: "horizontal" } };
export const Portrait: Story = {
	args: { variant: "vertical", aspect: "portrait" },
};
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
			<MediaCard {...args} variant="horizontal" />
		</div>
	),
};
