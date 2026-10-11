import type { Meta, StoryObj } from "@storybook/react-vite";
import { GenerationStatus } from "./GenerationStatus";

const meta: Meta<typeof GenerationStatus> = {
	title: "Components/GenerationStatus",
	component: GenerationStatus,
	tags: ["autodocs"],
};
export default meta;
type Story = StoryObj<typeof GenerationStatus>;
export const Music: Story = {
	args: {
		status: "running",
		title: "楽曲を生成しています",
		description: "曲の構成と音色を仕上げています。",
		onCancel: () => {},
	},
};
export const Image: Story = {
	args: {
		status: "running",
		title: "画像を生成しています",
		description: "細部を描いています。",
		progress: 62,
		onCancel: () => {},
	},
};
export const Waiting: Story = {
	args: {
		status: "pending",
		title: "生成の準備をしています",
		description: "処理の開始を待っています。",
	},
};
export const Failed: Story = {
	args: {
		status: "failed",
		title: "生成できませんでした",
		description: "接続を確認してから再試行してください。",
		onRetry: () => {},
	},
};
export const Completed: Story = {
	args: {
		status: "completed",
		title: "生成が完了しました",
		description: "成果物を開けます。",
	},
};
