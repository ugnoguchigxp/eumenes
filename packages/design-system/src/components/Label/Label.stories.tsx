import type { Meta, StoryObj } from "@storybook/react-vite";

import { Label } from "./Label";

const meta: Meta<typeof Label> = {
	title: "Components/Label",
	component: Label,
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
type Story = StoryObj<typeof Label>;

export const Default: Story = {
	args: {
		children: "Label",
	},
};
