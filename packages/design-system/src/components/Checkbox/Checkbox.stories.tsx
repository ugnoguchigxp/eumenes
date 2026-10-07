import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";

import { Checkbox } from "./Checkbox";

const meta: Meta<typeof Checkbox> = {
	title: "Components/Checkbox",
	component: Checkbox,
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
type Story = StoryObj<typeof Checkbox>;

export const Default: Story = {
	render: () => {
		const [checked, setChecked] = useState(false);
		return (
			<Checkbox checked={checked} onChange={setChecked} label="Accept terms" />
		);
	},
};

export const Card: Story = {
	render: () => {
		const [checked, setChecked] = useState(false);
		return (
			<div className="w-[400px]">
				<Checkbox
					checked={checked}
					onChange={setChecked}
					label="Confirm Treatment Step"
					variant="card"
				/>
			</div>
		);
	},
};
