import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";

import { NavigationStepper } from "./NavigationStepper";

const meta: Meta<typeof NavigationStepper> = {
	title: "Components/NavigationStepper",
	component: NavigationStepper,
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
type Story = StoryObj<typeof NavigationStepper>;

export const Default: Story = {
	render: () => {
		const [active, setActive] = useState(1);
		return (
			<NavigationStepper
				steps={[
					{ id: "s1", title: "Step 1", description: "First" },
					{ id: "s2", title: "Step 2", description: "Second" },
					{ id: "s3", title: "Step 3", description: "Third" },
				]}
				activeStep={active}
				onStepChange={setActive}
			/>
		);
	},
};
