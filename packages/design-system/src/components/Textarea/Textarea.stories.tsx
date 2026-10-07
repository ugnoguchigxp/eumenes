import type { Meta, StoryObj } from "@storybook/react-vite";

import { Textarea } from "./Textarea";

const meta: Meta<typeof Textarea> = {
	title: "Components/Textarea",
	component: Textarea,
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
type Story = StoryObj<typeof Textarea>;

export const Default: Story = {};
