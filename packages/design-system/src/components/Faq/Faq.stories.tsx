import type { Meta, StoryObj } from "@storybook/react-vite";
import { Faq } from "./Faq";

const meta: Meta<typeof Faq> = {
	title: "Components/Faq",
	component: Faq,
	tags: ["autodocs"],
};
export default meta;
type Story = StoryObj<typeof Faq>;

const items = [
	{
		question: "無料で試せますか。",
		answer: "はい。フリープランはずっと無料で使えます。",
	},
	{
		question: "途中でプランを変えられますか。",
		answer:
			"設定画面からいつでも変更できます。変更は次の請求日から反映されます。",
	},
	{
		question: "解約するとデータはどうなりますか。",
		answer: "解約後 30 日間は保管され、その後に削除されます。",
	},
];

export const Default: Story = { args: { title: "よくある質問", items } };
export const WithoutTitle: Story = { args: { items } };
export const Single: Story = {
	args: { title: "質問", items: items.slice(0, 1) },
};
export const Dark: Story = {
	args: { title: "よくある質問", items },
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
