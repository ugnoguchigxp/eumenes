import type { Meta, StoryObj } from "@storybook/react-vite";

import { TextInput } from "./TextInput";

const meta: Meta<typeof TextInput> = {
	title: "Components/TextInput",
	component: TextInput,
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
type Story = StoryObj<typeof TextInput>;

export const Default: Story = {
	args: {
		type: "text",
		placeholder: "テキストを入力...",
	},
};
