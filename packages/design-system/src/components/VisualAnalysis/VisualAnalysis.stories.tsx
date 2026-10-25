import type { Meta, StoryObj } from "@storybook/react-vite";
import { VisualAnalysis } from "./VisualAnalysis";
const meta = {
	title: "Media/VisualAnalysis",
	component: VisualAnalysis,
	args: { analysisAvailable: true, analysisOpen: true },
} satisfies Meta<typeof VisualAnalysis>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Ready: Story = {};
export const Starting: Story = {
	args: {
		analysis: {
			id: "sample",
			sourceId: "sample",
			sourceRevision: 1,
			frameIndex: null,
			createdAt: 1,
			state: "starting",
			options: { task: "describe", query: "この画像を説明してください。" },
			result: null,
			errorCode: null,
			releaseConfirmed: null,
			waitingMs: null,
			inferenceMs: null,
			elapsedMs: null,
		},
	},
};
export const Failure: Story = {
	args: {
		analysis: {
			...Starting.args!.analysis!,
			state: "failed",
			errorCode: "larm_http_429",
			releaseConfirmed: true,
		},
	},
};
export const Unavailable: Story = {
	args: { analysisAvailable: false, analysisOpen: false },
};
