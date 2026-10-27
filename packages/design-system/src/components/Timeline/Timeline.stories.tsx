import type { Meta, StoryObj } from "@storybook/react-vite";
import { Timeline } from "./Timeline";

const meta: Meta<typeof Timeline> = {
	title: "Components/Timeline",
	component: Timeline,
	tags: ["autodocs"],
};
export default meta;
type Story = StoryObj<typeof Timeline>;

const items = [
	{
		label: "1603 年",
		title: "江戸幕府が開かれる",
		body: "徳川家康が征夷大将軍に任じられました。",
	},
	{
		label: "1639 年",
		title: "鎖国体制が整う",
		body: "外国との交流が長崎などに限られました。",
	},
	{ label: "1853 年", title: "黒船が来航する" },
];

export const Default: Story = { args: { title: "江戸時代の歩み", items } };
export const WithoutLabels: Story = {
	args: { items: items.map(({ title, body }) => ({ title, body })) },
};
export const Dark: Story = {
	args: { title: "江戸時代の歩み", items },
	decorators: [
		(Story) => (
			<div
				className="ds-theme-dark"
				style={{
					background: "var(--background)",
					color: "var(--foreground)",
					padding: "1.5rem",
				}}
			>
				<Story />
			</div>
		),
	],
};
