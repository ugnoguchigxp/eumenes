import type { Meta, StoryObj } from "@storybook/react-vite";
import { ServerDataTable } from "./ServerDataTable";

type Row = { id: string; label: string };
const meta: Meta<typeof ServerDataTable<Row>> = {
	title: "Components/ServerDataTable",
	component: ServerDataTable<Row>,
	tags: ["autodocs"],
	args: {
		label: "利用記録",
		rows: [
			{ id: "1", label: "会話" },
			{ id: "2", label: "読み上げ" },
		],
		columns: [{ id: "label", header: "用途", accessorFn: (row) => row.label }],
		query: { pageIndex: 0, pageSize: 10, sort: "label", desc: false, q: "" },
		total: 125,
		onQuery: () => {},
	},
};
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Loading: Story = { args: { busy: true, rows: [] } };
export const Empty: Story = { args: { rows: [], total: 0 } };
export const Failed: Story = {
	args: { rows: [], error: "記録を取得できません。" },
};
