import type { Meta, StoryObj } from "@storybook/react-vite";
import { WorkResultPanel } from "./WorkResultPanel";
const meta = {
	title: "Work/WorkResultPanel",
	component: WorkResultPanel,
	args: {
		title: "比較調査レポート",
		status: "受取済み",
		summary: "調査の結果をまとめました。",
		sections: [
			{ title: "確認した内容", items: ["三つの候補を比較しました。"] },
		],
	},
} satisfies Meta<typeof WorkResultPanel>;
export default meta;
export const Completed: StoryObj<typeof meta> = {};
export const Question: StoryObj<typeof meta> = {
	args: {
		status: "回答待ち",
		question: {
			id: "q",
			prompt: "どちらの環境で進めますか？",
			choices: ["確認用", "実行用"],
		},
		canPause: true,
		canCancel: true,
		onAnswer: async () => true,
	},
};
