import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";

import { SearchableSelect } from "./SearchableSelect";

const meta: Meta<typeof SearchableSelect> = {
	title: "Components/SearchableSelect",
	component: SearchableSelect,
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
type Story = StoryObj<typeof SearchableSelect>;

export const Default: Story = {
	render: () => {
		const [value, setValue] = useState("b");
		return (
			<SearchableSelect
				className="w-full border border-border rounded px-2 py-2 bg-card text-foreground"
				placeholder="Select..."
				value={value}
				onChange={setValue}
				options={[
					{ value: "a", label: "Option A" },
					{ value: "b", label: "Option B" },
					{ value: "c", label: "Option C" },
					{ value: "apple", label: "Apple" },
					{ value: "banana", label: "Banana" },
					{ value: "cherry", label: "Cherry" },
				]}
			/>
		);
	},
};
