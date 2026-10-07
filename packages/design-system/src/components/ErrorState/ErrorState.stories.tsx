import type { Meta, StoryObj } from "@storybook/react-vite";

import { ErrorState } from "./ErrorState";

const meta: Meta<typeof ErrorState> = {
	title: "Components/ErrorState",
	component: ErrorState,
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
type Story = StoryObj<typeof ErrorState>;

export const Default: Story = {
	args: {
		error: new Error("Something went wrong"),
		onRetry: () => {},
	},
};
