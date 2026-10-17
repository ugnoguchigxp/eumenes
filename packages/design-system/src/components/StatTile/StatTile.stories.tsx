import type { Meta, StoryObj } from "@storybook/react-vite";
import { StatTile } from "./StatTile";

const meta: Meta<typeof StatTile> = {
	title: "Components/StatTile",
	component: StatTile,
	tags: ["autodocs"],
};
export default meta;
type Story = StoryObj<typeof StatTile>;

export const Default: Story = {
	args: { label: "65 歳時点の資産", value: "¥18,420,000", caption: "年利 3% の試算" },
};
export const Up: Story = { args: { label: "前月比", value: "+12%", trend: "up" } };
export const Down: Story = { args: { label: "前月比", value: "-4%", trend: "down" } };
export const Flat: Story = { args: { label: "前月比", value: "0%", trend: "flat" } };
export const Invalid: Story = {
	args: { label: "月々の返済額", value: "—", caption: "入力値を確認してください" },
};
export const Dark: Story = {
	args: { label: "65 歳時点の資産", value: "¥18,420,000", trend: "up", caption: "試算" },
	decorators: [
		(Story) => (
			<div className="ds-theme-dark" style={{ background: "var(--background)", color: "var(--foreground)", padding: "1.5rem" }}>
				<Story />
			</div>
		),
	],
};
