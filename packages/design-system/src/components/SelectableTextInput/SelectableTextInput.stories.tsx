import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";

import { SelectableTextInput } from "./SelectableTextInput";

const meta: Meta<typeof SelectableTextInput> = {
	title: "Components/SelectableTextInput",
	component: SelectableTextInput,
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
type Story = StoryObj<typeof SelectableTextInput>;

export const Default: Story = {
	render: () => {
		const [value, setValue] = useState("a");
		return (
			<SelectableTextInput
				className="max-w-sm"
				value={value}
				onChange={setValue}
				placeholder="Free text..."
				options={[
					{ value: "a", label: "Option A" },
					{ value: "b", label: "Option B" },
					{ value: "c", label: "Option C" },
				]}
			/>
		);
	},
};
