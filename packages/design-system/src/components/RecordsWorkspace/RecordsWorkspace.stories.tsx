import type { Meta, StoryObj } from "@storybook/react-vite";
import { RecordsWorkspace } from "./RecordsWorkspace";

const meta: Meta<typeof RecordsWorkspace> = {
	title: "Components/RecordsWorkspace",
	component: RecordsWorkspace,
	tags: ["autodocs"],
	args: {
		tabs: [
			{
				id: "ai",
				label: "AIの利用",
				description: "直近100件の利用記録です。",
				rows: [
					{
						id: "1",
						label: "会話",
						summary: ["2026/10/13 10:00", "LARM / Gemma", "採用済み"],
						details: [{ label: "入力 / 出力トークン", value: "120 / 48" }],
					},
				],
			},
			{
				id: "toolchains",
				label: "ツールチェーン",
				description: "処理の選択と実行結果です。",
				rows: [],
				procedures: [
					{
						id: "r1",
						label: "天気の取得",
						url: "https://example.com/weather",
						description: "成功 3回・失敗 0回",
						status: "有効",
						enabled: true,
					},
				],
			},
		],
		dataDescription: ["会話・設定は端末に保存します。"],
		onRefresh: () => {},
		onQuery: () => {},
		onProcedureState: () => {},
		onProcedureDelete: () => {},
		onDownload: () => {},
	},
};
export default meta;
type Story = StoryObj<typeof RecordsWorkspace>;
export const Default: Story = {};
export const Loading: Story = {
	args: {
		tabs: [
			{
				id: "ai",
				label: "AIの利用",
				description: "利用記録",
				rows: [],
				loading: true,
			},
		],
	},
};
export const Failed: Story = {
	args: {
		tabs: [
			{
				id: "ai",
				label: "AIの利用",
				description: "利用記録",
				rows: [],
				error: "記録を読み込めません。",
			},
		],
		dataError: "接続状態を読み込めません。",
	},
};
export const Empty: Story = {
	args: {
		tabs: [{ id: "ai", label: "AIの利用", description: "利用記録", rows: [] }],
	},
};
export const Busy: Story = { args: { busy: true, message: "処理中です" } };
