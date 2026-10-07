import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";

import { ScaleInput } from "./ScaleInput";

const meta: Meta<typeof ScaleInput> = {
	title: "Components/ScaleInput",
	component: ScaleInput,
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
type Story = StoryObj<typeof ScaleInput>;

export const Default: Story = {
	render: () => {
		const [val, setVal] = useState<number | undefined>(undefined);
		return (
			<ScaleInput
				label="Pain Level"
				value={val}
				onChange={setVal}
				minLabel="No Pain"
				maxLabel="Worst Pain"
			/>
		);
	},
};

export const Selected: Story = {
	render: () => (
		<ScaleInput
			label="Pain Level (Initial Value)"
			value={5}
			onChange={() => {}}
			minLabel="No Pain"
			maxLabel="Worst Pain"
		/>
	),
};

export const Disabled: Story = {
	render: () => (
		<ScaleInput label="Disabled Scale" value={3} onChange={() => {}} disabled />
	),
};
