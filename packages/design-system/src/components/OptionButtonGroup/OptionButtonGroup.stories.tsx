import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import {
	OptionButtonGroup,
	type OptionButtonGroupProps,
} from "./OptionButtonGroup";

const meta: Meta<typeof OptionButtonGroup> = {
	title: "Components/OptionButtonGroup",
	component: OptionButtonGroup,
	parameters: {
		layout: "centered",
	},
	tags: ["autodocs"],
};

export default meta;
type Story = StoryObj<typeof OptionButtonGroup>;

const options = [
	{ value: "option1", label: "Option 1", description: "Description 1" },
	{ value: "option2", label: "Option 2", description: "Description 2" },
	{ value: "option3", label: "Option 3", description: "Description 3" },
	{ value: "option4", label: "Option 4", description: "Description 4" },
];

const OptionButtonGroupWithState = (args: OptionButtonGroupProps<string>) => {
	const [value, setValue] = useState<string | string[] | null>(
		args.value ?? null,
	);
	if (args.multiple) {
		const currentValue = Array.isArray(value) ? value : [];
		return (
			<div className="w-[600px]">
				<OptionButtonGroup
					{...args}
					value={currentValue}
					onChange={(nextValue: string[]) => setValue(nextValue)}
				/>
				<div className="mt-4 text-sm text-muted-foreground">
					Selected Value: {currentValue.join(", ") || "none"}
				</div>
			</div>
		);
	}

	const currentValue =
		typeof value === "string" || value === null ? value : null;
	return (
		<div className="w-[600px]">
			<OptionButtonGroup
				{...args}
				value={currentValue}
				onChange={(nextValue: string | null) => setValue(nextValue)}
			/>
			<div className="mt-4 text-sm text-muted-foreground">
				Selected Value: {currentValue === null ? "null" : currentValue}
			</div>
		</div>
	);
};

export const Default: Story = {
	render: (args) => <OptionButtonGroupWithState {...args} />,
	args: {
		options: options.slice(0, 2),
		columns: 2,
		allowNull: false,
	},
};

export const WithNullOption: Story = {
	render: (args) => <OptionButtonGroupWithState {...args} />,
	args: {
		options: options.slice(0, 2),
		columns: 2,
		allowNull: true,
		nullLabel: "Unspecified",
	},
};

export const FourColumns: Story = {
	render: (args) => <OptionButtonGroupWithState {...args} />,
	args: {
		options: options,
		columns: 4,
		allowNull: false,
	},
};

export const WithDescriptions: Story = {
	render: (args) => <OptionButtonGroupWithState {...args} />,
	args: {
		options: options,
		columns: 2,
		allowNull: false,
	},
};
