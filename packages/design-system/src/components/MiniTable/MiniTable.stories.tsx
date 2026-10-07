import type { Meta, StoryObj } from "@storybook/react-vite";

import { MiniTable } from "./MiniTable";

const meta: Meta<typeof MiniTable> = {
	title: "Components/MiniTable",
	component: MiniTable,
	tags: ["autodocs"],
	decorators: [
		(Story) => (
			<>
				<div
					style={{ padding: "2rem", backgroundColor: "hsl(var(--background))" }}
				>
					<Story />
				</div>
			</>
		),
	],
};

export default meta;
type Story = StoryObj<typeof MiniTable>;

export const Default: Story = {
	args: {
		columns: [
			{ key: "name", label: "Name", width: "1fr" },
			{ key: "qty", label: "Qty", align: "right", width: "72px" },
		],
		rows: [
			{ key: "r1", cells: { name: "Item A", qty: 3 } },
			{ key: "r2", cells: { name: "Item B", qty: 12 } },
		],
	},
};
