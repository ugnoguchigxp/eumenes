import type { Meta, StoryObj } from "@storybook/react-vite";

import { ContentHeader } from "./ContentHeader";

const meta: Meta<typeof ContentHeader> = {
	title: "Components/ContentHeader",
	component: ContentHeader,
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
type Story = StoryObj<typeof ContentHeader>;

export const Default: Story = {
	args: {
		patientName: "山田 太郎",
		patientId: "P-001",
		additionalInfo: "透析 3回/週",
	},
};
