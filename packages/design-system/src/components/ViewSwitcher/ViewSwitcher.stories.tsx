import type { Meta, StoryObj } from "@storybook/react-vite";
import { LayoutGrid, List, Table } from "lucide-react";
import { useState } from "react";

import { ViewSwitcher } from "./ViewSwitcher";

const meta: Meta<typeof ViewSwitcher> = {
	title: "Components/ViewSwitcher",
	component: ViewSwitcher,
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
type Story = StoryObj<typeof ViewSwitcher>;

export const Default: Story = {
	render: () => {
		const [value, setValue] = useState("grid");
		return (
			<ViewSwitcher
				value={value}
				onChange={setValue}
				options={[
					{ value: "grid", icon: LayoutGrid, tooltip: "Grid" },
					{ value: "list", icon: List, tooltip: "List" },
					{ value: "table", icon: Table, tooltip: "Table" },
				]}
			/>
		);
	},
};
