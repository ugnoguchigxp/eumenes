import type { Meta, StoryObj } from "@storybook/react-vite";
import { ComparisonTable } from "./ComparisonTable";

const meta: Meta<typeof ComparisonTable> = {
	title: "Components/ComparisonTable",
	component: ComparisonTable,
	tags: ["autodocs"],
};
export default meta;
type Story = StoryObj<typeof ComparisonTable>;

const args = {
	title: "プランの比較",
	columns: ["フリー", "スタンダード", "プロ"],
	rows: [
		{ label: "月額", values: ["¥0", "¥1,200", "¥4,800"] },
		{ label: "プロジェクト数", values: ["1", "10", "無制限"] },
		{ label: "共有", values: [false, true, true] },
		{ label: "優先サポート", values: [false, false, true] },
	],
};

export const Default: Story = { args };
export const Highlighted: Story = { args: { ...args, highlightColumn: 1 } };
export const NarrowScroll: Story = {
	args: { ...args, highlightColumn: 2 },
	decorators: [
		(Story) => (
			<div style={{ width: "18rem" }}>
				<Story />
			</div>
		),
	],
};
export const Dark: Story = {
	args: { ...args, highlightColumn: 1 },
	decorators: [
		(Story) => (
			<div className="ds-theme-dark" style={{ background: "var(--background)", color: "var(--foreground)", padding: "1.5rem" }}>
				<Story />
			</div>
		),
	],
};
