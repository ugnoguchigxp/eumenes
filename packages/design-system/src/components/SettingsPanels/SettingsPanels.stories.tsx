import type { Meta, StoryObj } from "@storybook/react-vite";
import { SettingsSection } from ".";

const meta: Meta<typeof SettingsSection> = {
	title: "Components/SettingsSection",
	component: SettingsSection,
	tags: ["autodocs"],
};
export default meta;
type Story = StoryObj<typeof SettingsSection>;
export const Conversation: Story = {
	args: {
		title: "会話",
		description: "名前と口調を設定します。",
		dirty: false,
		fields: [
			{
				id: "name",
				label: "AIの名前",
				help: "空欄の場合は名前を設定しません。",
				control: "text",
				value: "",
				maxLength: 40,
			},
			{
				id: "user",
				label: "あなたの名前",
				control: "text",
				value: "",
				maxLength: 40,
			},
			{
				id: "persona",
				label: "口調",
				control: "select",
				value: "butler",
				options: [
					{ value: "butler", label: "執事" },
					{ value: "strategist", label: "参謀" },
				],
			},
		],
		onChange: () => {},
		onReview: () => {},
	},
};
export const Pending: Story = { args: { ...Conversation.args, dirty: true } };
