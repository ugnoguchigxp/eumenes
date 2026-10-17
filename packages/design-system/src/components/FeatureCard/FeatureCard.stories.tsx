import type { Meta, StoryObj } from "@storybook/react-vite";
import { FeatureCard, featureCardIconNames } from "./FeatureCard";

const meta: Meta<typeof FeatureCard> = {
	title: "Components/FeatureCard",
	component: FeatureCard,
	tags: ["autodocs"],
	args: {
		icon: "truck",
		title: "全国送料無料",
		body: "3,000円以上のご注文で、全国どこへでも送料無料でお届けします。",
	},
	decorators: [
		(Story) => (
			<div style={{ maxWidth: 360 }}>
				<Story />
			</div>
		),
	],
};
export default meta;
type Story = StoryObj<typeof FeatureCard>;
export const Default: Story = {};
export const WithoutIcon: Story = { args: { icon: undefined } };
export const TitleOnly: Story = { args: { body: undefined } };
export const AllIcons: Story = {
	decorators: [],
	render: () => (
		<div
			style={{
				display: "grid",
				gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
				gap: 12,
			}}
		>
			{featureCardIconNames.map((name) => (
				<FeatureCard key={name} icon={name} title={name} />
			))}
		</div>
	),
};
export const Dark: Story = {
	render: (args) => (
		<div
			className="ds-theme-dark"
			style={{
				background: "var(--background)",
				color: "var(--foreground)",
				padding: 16,
			}}
		>
			<FeatureCard {...args} />
		</div>
	),
};
