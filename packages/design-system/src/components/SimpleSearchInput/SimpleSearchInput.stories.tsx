import type { Meta, StoryObj } from "@storybook/react-vite";

import { SimpleSearchInput } from "./SimpleSearchInput";

const meta: Meta<typeof SimpleSearchInput> = {
	title: "Components/SimpleSearchInput",
	component: SimpleSearchInput,
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
type Story = StoryObj<typeof SimpleSearchInput>;

export const Default: Story = {};
