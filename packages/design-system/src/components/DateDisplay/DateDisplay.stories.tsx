import type { Meta, StoryObj } from "@storybook/react-vite";

import { DateDisplay } from "./DateDisplay";

const meta: Meta<typeof DateDisplay> = {
	title: "Components/DateDisplay",
	component: DateDisplay,
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
type Story = StoryObj<typeof DateDisplay>;

export const Default: Story = {
	args: {
		date: new Date("2025-10-23T12:34:56Z"),
		format: "full",
	},
};
