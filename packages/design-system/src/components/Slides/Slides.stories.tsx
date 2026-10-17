import type { Meta, StoryObj } from "@storybook/react-vite";
import { Slides } from "./Slides";

const meta: Meta<typeof Slides> = {
	title: "Components/Slides",
	component: Slides,
	tags: ["autodocs"],
};
export default meta;
type Story = StoryObj<typeof Slides>;

const slides = [
	{ label: "むかしむかし", content: <p>あるところに、おじいさんとおばあさんが住んでいました。</p> },
	{ label: "川で", content: <p>おばあさんが川で洗濯をしていると、大きな桃が流れてきました。</p> },
	{ label: "桃から", content: <p>桃を割ると、中から元気な男の子が生まれました。</p> },
	{ label: "おしまい", content: <p>めでたし、めでたし。</p> },
];

export const Default: Story = { args: { title: "桃太郎", slides } };
export const SingleSlide: Story = { args: { slides: slides.slice(0, 1) } };
export const WithoutTitle: Story = { args: { slides } };
export const Dark: Story = {
	args: { title: "桃太郎", slides },
	decorators: [
		(Story) => (
			<div className="ds-theme-dark" style={{ background: "var(--background)", color: "var(--foreground)", padding: "1.5rem" }}>
				<Story />
			</div>
		),
	],
};
