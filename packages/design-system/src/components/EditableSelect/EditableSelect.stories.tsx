import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";

import { EditableSelect } from "./EditableSelect";

const meta: Meta<typeof EditableSelect> = {
	title: "Components/EditableSelect",
	component: EditableSelect,
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
type Story = StoryObj<typeof EditableSelect>;

export const Default: Story = {
	render: () => {
		const [value, setValue] = useState("10");
		return (
			<div className="max-w-[240px]">
				<EditableSelect
					value={value}
					onChange={setValue}
					options={[5, 10, 15, 20]}
					placeholder="Select..."
				/>
			</div>
		);
	},
};

export const Variants: Story = {
	render: () => {
		const [valueA, setValueA] = useState("10");
		const [valueB, setValueB] = useState("10");
		const [valueC, setValueC] = useState("10");

		return (
			<div className="space-y-4">
				<div className="max-w-sm space-y-2">
					<div className="text-sm font-semibold text-foreground">default</div>
					<EditableSelect
						value={valueA}
						onChange={setValueA}
						options={[5, 10, 15, 20]}
						placeholder="Type or pick..."
						variant="default"
						size="md"
					/>
				</div>

				<div className="max-w-sm space-y-2">
					<div className="text-sm font-semibold text-foreground">outline</div>
					<EditableSelect
						value={valueB}
						onChange={setValueB}
						options={[5, 10, 15, 20]}
						placeholder="Type or pick..."
						variant="outline"
						size="md"
					/>
				</div>

				<div className="max-w-sm space-y-2">
					<div className="text-sm font-semibold text-foreground">ghost</div>
					<EditableSelect
						value={valueC}
						onChange={setValueC}
						options={[5, 10, 15, 20]}
						placeholder="Type or pick..."
						variant="ghost"
						size="md"
					/>
				</div>
			</div>
		);
	},
};
