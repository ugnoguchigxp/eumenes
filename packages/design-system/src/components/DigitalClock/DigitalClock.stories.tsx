import type { Meta, StoryObj } from "@storybook/react-vite";
import { DigitalClock } from "./DigitalClock";

const meta: Meta<typeof DigitalClock> = {
	title: "Components/DigitalClock",
	component: DigitalClock,
	tags: ["autodocs"],
};
export default meta;
type Story = StoryObj<typeof DigitalClock>;

export const ThreeMinutes: Story = { args: { seconds: 180, size: "hero" } };
export const OverOneHour: Story = { args: { seconds: 3661, size: "hero" } };
export const FullDay: Story = { args: { seconds: 86400, size: "hero" } };
export const Finished: Story = {
	args: { seconds: 0, tone: "finished", size: "hero", label: "終了" },
};
export const Muted: Story = { args: { seconds: 120, tone: "muted", size: "lg" } };
export const Narrow: Story = {
	args: { seconds: 86400, size: "hero" },
	decorators: [
		(Story) => (
			<div style={{ width: 180 }}>
				<Story />
			</div>
		),
	],
};
