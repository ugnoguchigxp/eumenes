import type { Meta, StoryObj } from "@storybook/react";
import { ActivityTimeline } from "./ActivityTimeline";
const meta: Meta<typeof ActivityTimeline> = {
	title: "Components/ActivityTimeline",
	component: ActivityTimeline,
	args: { entries: [] },
};
export default meta;
type Story = StoryObj<typeof ActivityTimeline>;
export const Empty: Story = {};
export const Running: Story = {
	args: {
		entries: [
			{
				id: "1",
				at: "2026-10-15T00:00:00.000Z",
				title: "作業を開始しました",
				status: "working",
			},
			{
				id: "2",
				at: "2026-10-15T00:00:03.000Z",
				title: "検証を実行しました",
				status: "completed",
				detail: "検証の終了コード: 0",
			},
		],
	},
};
export const Disconnected: Story = {
	args: { ...Running.args, connected: false },
};
export const LongDetail: Story = {
	args: {
		entries: [
			{
				id: "1",
				at: "2026-10-15T00:00:00.000Z",
				title: "確認が必要です",
				status: "unknown",
				detail: "確認が必要な項目\n".repeat(150),
				truncated: true,
			},
		],
	},
};
