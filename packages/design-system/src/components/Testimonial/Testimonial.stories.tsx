import type { Meta, StoryObj } from "@storybook/react-vite";
import { Testimonial } from "./Testimonial";

const meta: Meta<typeof Testimonial> = {
	title: "Components/Testimonial",
	component: Testimonial,
	tags: ["autodocs"],
	args: {
		quote:
			"届いた日からすぐに使えて、毎朝の準備が楽になりました。家族にも好評です。",
		name: "佐藤 花子",
		role: "会社員・東京都",
	},
	decorators: [
		(Story) => (
			<div style={{ maxWidth: 480 }}>
				<Story />
			</div>
		),
	],
};
export default meta;
type Story = StoryObj<typeof Testimonial>;
export const Default: Story = {};
export const WithAvatar: Story = {
	args: { avatar: { placeholder: "cool", alt: "佐藤さん" } },
};
export const AvatarLoadFailed: Story = {
	args: {
		avatar: { src: "https://invalid.example/missing.jpg", alt: "佐藤さん" },
	},
};
export const WithoutRole: Story = { args: { role: undefined } };
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
			<Testimonial {...args} />
		</div>
	),
};
