import type { Meta, StoryObj } from "@storybook/react-vite";
import { Calculator } from "./Calculator";

const meta = {
	title: "Components/Calculator",
	component: Calculator,
	parameters: {
		layout: "centered",
	},
	tags: ["autodocs"],
} satisfies Meta<typeof Calculator>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Inline: Story = {
	args: { display: "inline", className: "w-72" },
};

export const Scientific: Story = {
	args: { display: "inline", mode: "scientific", className: "w-80" },
};

export const WithInitialExpression: Story = {
	args: {
		display: "inline",
		mode: "scientific",
		initialExpression: "1000 * tan(89.5)",
		className: "w-80",
	},
};

export const HostEvaluate: Story = {
	args: {
		display: "inline",
		mode: "scientific",
		initialExpression: "2 * 21",
		evaluate: (expression) => (expression === "2 * 21" ? 42 : null),
		className: "w-80",
	},
};

export const ScientificDark: Story = {
	args: Scientific.args,
	render: (args) => (
		<div
			className="ds-theme-dark"
			style={{ background: "var(--background)", color: "var(--foreground)", padding: "1.5rem" }}
		>
			<Calculator {...args} />
		</div>
	),
};
