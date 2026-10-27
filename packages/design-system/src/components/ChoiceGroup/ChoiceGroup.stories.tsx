import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { ChoiceGroup, type ChoiceGroupProps } from "./ChoiceGroup";

const meta: Meta<typeof ChoiceGroup> = {
	title: "Components/ChoiceGroup",
	component: ChoiceGroup,
	tags: ["autodocs"],
};
export default meta;
type Story = StoryObj<typeof ChoiceGroup>;

function Controlled(
	args: Omit<ChoiceGroupProps, "value" | "onChange"> & { initial?: string },
) {
	const { initial = "", ...rest } = args;
	const [value, setValue] = useState(initial);
	return <ChoiceGroup {...rest} value={value} onChange={setValue} />;
}

const options = ["朝型", "夜型", "どちらでもない"];

export const Buttons: Story = {
	render: () => (
		<Controlled label="生活リズム" options={options} initial="朝型" />
	),
};
export const ButtonsUnselected: Story = {
	render: () => <Controlled label="生活リズム" options={options} />,
};
export const Cards: Story = {
	render: () => (
		<Controlled
			label="Q1. 休日の過ごし方は？"
			display="cards"
			options={[
				"家でのんびり",
				"友達と出かける",
				"新しい場所へ行く",
				"趣味に没頭する",
			]}
			initial="友達と出かける"
		/>
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
			<Controlled
				label="Q1. 休日の過ごし方は？"
				display="cards"
				options={options}
				initial="夜型"
			/>
		</div>
	),
};
