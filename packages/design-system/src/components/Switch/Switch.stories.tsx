import type { Meta, StoryObj } from "@storybook/react-vite";
import { Switch } from "./Switch";

const meta: Meta<typeof Switch> = {
	title: "Components/Switch",
	component: Switch,
	parameters: {
		layout: "centered",
	},
	args: {
		disabled: false,
	},
};

export default meta;
type Story = StoryObj<typeof Switch>;

export const Default: Story = {
	args: {
		"aria-label": "Toggle switch",
	},
};

export const Checked: Story = {
	args: {
		defaultChecked: true,
		"aria-label": "Toggle switch",
	},
};

export const Disabled: Story = {
	args: {
		disabled: true,
		"aria-label": "Toggle switch",
	},
};

export const WithLabel: Story = {
	render: (args) => (
		<div className="flex items-center space-x-2">
			<Switch id="airplane-mode" {...args} />
			<label
				htmlFor="airplane-mode"
				className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
			>
				Airplane Mode
			</label>
		</div>
	),
};
