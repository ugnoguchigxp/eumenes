import type { Meta, StoryObj } from "@storybook/react-vite";
import { SubtitlePreview } from "./SubtitlePreview";

const meta: Meta<typeof SubtitlePreview> = {
	title: "Components/SubtitlePreview",
	component: SubtitlePreview,
	tags: ["autodocs"],
	args: {
		text: "これは字幕のプレビューです。",
		style: "netflix",
		size: "large",
		enabled: true,
	},
};
export default meta;
type Story = StoryObj<typeof SubtitlePreview>;
export const Cinema: Story = {};
export const Box: Story = { args: { style: "prime" } };
export const Classic: Story = { args: { style: "classic" } };
export const Glass: Story = { args: { style: "glass" } };
export const Medium: Story = { args: { size: "medium" } };
export const ExtraLarge: Story = {
	args: {
		size: "xlarge",
		text: "長い文章も画面の幅に合わせて折り返す字幕のプレビューです。",
	},
};
export const Disabled: Story = { args: { enabled: false } };
