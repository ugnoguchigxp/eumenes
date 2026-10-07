import type { Meta, StoryObj } from "@storybook/react-vite";

import { CopyClipButton } from "./CopyClipButton";

const meta: Meta<typeof CopyClipButton> = {
	title: "Components/CopyClipButton",
	component: CopyClipButton,
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
type Story = StoryObj<typeof CopyClipButton>;

export const Default: Story = {
	args: {
		text: "Click to copy",
		copyValue: "Copied value",
	},
};
