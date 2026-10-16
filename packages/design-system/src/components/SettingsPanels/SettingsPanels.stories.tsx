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
		onApply: () => {},
	},
};
export const Pending: Story = { args: { ...Conversation.args, dirty: true } };
export const Saving: Story = { args: { ...Pending.args, busy: true } };
export const SaveFailed: Story = {
	args: {
		...Pending.args,
		message: "適用できませんでした。接続を確認してもう一度保存してください。",
	},
};

export const VoiceInput: Story = {
	args: {
		title: "音声と入力",
		description: "声と音声入力を設定します。",
		dirty: true,
		groups: [
			{
				id: "speech",
				label: "読み上げ",
				description: "サービスが対応する項目を表示します。",
			},
			{ id: "input", label: "聞き取り" },
			{ id: "devices", label: "機器" },
		],
		fields: [
			{
				id: "enabled",
				label: "回答を読み上げる",
				control: "toggle",
				group: "speech",
				value: "true",
			},
			{
				id: "volume",
				label: "音量",
				control: "range",
				group: "speech",
				value: ".8",
				minimum: 0,
				maximum: 1,
				step: 0.05,
			},
			{
				id: "voice",
				label: "キャラクター",
				control: "select",
				group: "speech",
				searchable: true,
				value: "default",
				options: [{ value: "default", label: "既定の声" }],
			},
			{
				id: "intonation",
				label: "抑揚",
				control: "range",
				group: "speech",
				detail: true,
				value: "1",
				minimum: 0,
				maximum: 2,
				step: 0.05,
			},
			{
				id: "languages",
				label: "利用する言語",
				control: "multiple",
				group: "input",
				value: '["ja","en"]',
				options: [
					{ value: "ja", label: "日本語" },
					{ value: "en", label: "英語" },
				],
			},
			{
				id: "silence",
				label: "発話を確定する無音時間（ミリ秒）",
				control: "number",
				group: "input",
				detail: true,
				value: "1500",
				minimum: 300,
				maximum: 3000,
				step: 100,
			},
			{
				id: "mic",
				label: "マイク",
				control: "select",
				group: "devices",
				value: "",
				options: [{ value: "", label: "システム標準" }],
			},
		],
		actions: [
			{ id: "sample", label: "サンプルを再生", group: "speech" },
			{ id: "discover", label: "音声機器を確認", group: "devices" },
		],
		onChange: () => {},
		onReview: () => {},
		onAction: () => {},
		onApply: () => {},
	},
};
