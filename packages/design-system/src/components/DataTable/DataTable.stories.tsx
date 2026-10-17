import type { Meta, StoryObj } from "@storybook/react-vite";
import { DataTable } from "./DataTable";

const meta = {
	title: "Components/DataTable",
	component: DataTable,
	parameters: { layout: "padded" },
	tags: ["autodocs"],
} satisfies Meta<typeof DataTable>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
	args: {
		title: "都市の人口",
		columns: [{ header: "都市" }, { header: "地方" }, { header: "人口（人）" }],
		rows: [
			["東京", "関東", 13960000],
			["大阪", "近畿", 8840000],
			["名古屋", "中部", 2330000],
		],
	},
};

export const Omitted: Story = {
	args: { ...Default.args, omittedRows: 197 },
};

export const Dark: Story = {
	args: Default.args,
	render: (args) => (
		<div
			className="ds-theme-dark"
			style={{ background: "var(--background)", color: "var(--foreground)", padding: "1.5rem" }}
		>
			<DataTable {...args} />
		</div>
	),
};
