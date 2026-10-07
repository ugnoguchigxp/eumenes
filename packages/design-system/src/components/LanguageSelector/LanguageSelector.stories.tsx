import type { Meta, StoryObj } from "@storybook/react-vite";

import { LanguageSelector } from "./LanguageSelector";

const meta: Meta<typeof LanguageSelector> = {
	title: "Components/LanguageSelector",
	component: LanguageSelector,
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
type Story = StoryObj<typeof LanguageSelector>;

export const Default: Story = {};
