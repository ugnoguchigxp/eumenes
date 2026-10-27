import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { RangeSlider, type RangeSliderProps } from "./RangeSlider";

const meta: Meta<typeof RangeSlider> = {
	title: "Components/RangeSlider",
	component: RangeSlider,
	tags: ["autodocs"],
};
export default meta;
type Story = StoryObj<typeof RangeSlider>;

function Controlled(
	args: Omit<RangeSliderProps, "value" | "onChange"> & { initial: number },
) {
	const { initial, ...rest } = args;
	const [value, setValue] = useState(initial);
	return <RangeSlider {...rest} value={value} onChange={setValue} />;
}

export const Default: Story = {
	render: () => <Controlled label="年齢" initial={40} min={20} max={70} />,
};
export const Formatted: Story = {
	render: () => (
		<Controlled
			label="毎月の積立額"
			initial={30000}
			min={0}
			max={500000}
			step={1000}
			formatValue={(n) => `¥${n.toLocaleString("ja-JP")}`}
		/>
	),
};
export const AtMinimum: Story = {
	render: () => (
		<Controlled
			label="利回り"
			initial={0}
			min={0}
			max={15}
			step={0.5}
			formatValue={(n) => `${n}%`}
		/>
	),
};
export const Disabled: Story = {
	render: () => (
		<Controlled label="年齢" initial={40} min={20} max={70} disabled />
	),
};
export const Dark: Story = {
	render: () => (
		<div
			className="ds-theme-dark"
			style={{
				background: "var(--background)",
				color: "var(--foreground)",
				padding: "1.5rem",
			}}
		>
			<Controlled label="年齢" initial={40} min={20} max={70} />
		</div>
	),
};
