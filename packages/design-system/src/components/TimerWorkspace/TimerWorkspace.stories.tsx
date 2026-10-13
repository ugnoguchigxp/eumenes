import type { Meta, StoryObj } from "@storybook/react-vite";
import { TimerWorkspace } from "./TimerWorkspace";

const meta: Meta<typeof TimerWorkspace> = {
	title: "Components/TimerWorkspace",
	component: TimerWorkspace,
	tags: ["autodocs"],
};
export default meta;
type Story = StoryObj<typeof TimerWorkspace>;
export const Setup: Story = {
	args: { state: "setup", stopwatch: { elapsedMs: 0, running: false } },
};
export const Running: Story = {
	args: {
		state: "active",
		title: "お茶の時間",
		durationSeconds: 180,
		remainingSeconds: 128,
		durationLabel: "3分",
		dueAt: "2026-10-12T10:03:00Z",
		finishLabel: "19:03",
		onCancel: () => {},
		onPause: () => {},
		onResume: () => {},
		onNew: () => {},
	},
};
export const Finished: Story = {
	args: { ...Running.args, state: "elapsed", remainingSeconds: 0 },
};
export const Paused: Story = {
	args: { ...Running.args, state: "paused", dueAt: undefined },
};
export const Cancelled: Story = {
	args: { ...Running.args, state: "cancelled", dueAt: undefined },
};
export const Error: Story = {
	args: {
		state: "setup",
		error: "タイマーを開始できませんでした。もう一度お試しください。",
	},
};
export const Narrow: Story = {
	args: Setup.args,
	decorators: [
		(Story) => (
			<div style={{ width: 280 }}>
				<Story />
			</div>
		),
	],
};
export const Stopwatch: Story = {
	args: {
		state: "setup",
		mode: "stopwatch",
		stopwatch: { elapsedMs: 62345, running: true },
	},
};
export const StopwatchStopped: Story = {
	args: { ...Stopwatch.args, stopwatch: { elapsedMs: 62345, running: false } },
};
