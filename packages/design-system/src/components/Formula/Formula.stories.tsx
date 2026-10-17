import type { Meta, StoryObj } from "@storybook/react-vite";
import { Formula } from "./Formula";

const meta = {
	title: "Components/Formula",
	component: Formula,
	parameters: { layout: "padded" },
	tags: ["autodocs"],
} satisfies Meta<typeof Formula>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
	args: { tex: "E = mc^2", caption: "質量とエネルギーの等価性" },
};

export const WithValue: Story = {
	args: {
		label: "ステップ2",
		tex: "d = \\frac{h}{\\tan\\theta}",
		value: "= 384,400 km",
		caption: "視差から月までの距離を求める",
	},
};

export const Long: Story = {
	args: {
		label: "解の公式",
		tex: "x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}",
	},
};

export const Invalid: Story = {
	args: { label: "壊れた数式", tex: "\\frac{1", value: "= 1" },
};

export const Dark: Story = {
	args: WithValue.args,
	render: (args) => (
		<div
			className="ds-theme-dark"
			style={{
				background: "var(--background)",
				color: "var(--foreground)",
				padding: "1.5rem",
			}}
		>
			<Formula {...args} />
		</div>
	),
};
