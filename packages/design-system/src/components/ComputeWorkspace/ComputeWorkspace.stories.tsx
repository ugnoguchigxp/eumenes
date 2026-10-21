import type { Meta, StoryObj } from "@storybook/react-vite";
import { ComputeWorkspace } from ".";
const meta: Meta<typeof ComputeWorkspace> = {
	title: "Components/ComputeWorkspace",
	component: ComputeWorkspace,
	tags: ["autodocs"],
	decorators: [
		(Story) => (
			<div style={{ width: "50vw", maxWidth: "100%" }}>
				<Story />
			</div>
		),
	],
	args: {
		available: true,
		jobs: [],
		onCancel: () => {},
		onReconcile: () => {},
		onRefresh: () => {},
		onDownload: () => {},
	},
};
export default meta;
type Story = StoryObj<typeof ComputeWorkspace>;
export const Empty: Story = {};
export const Running: Story = {
	args: {
		jobs: [
			{
				id: "job-a",
				state: "running",
				stage: "running",
				code: "result = 1 + 1",
				cancelRequested: false,
				progress: { message: "計算中", ratio: 0.5 },
				result: null,
				error: null,
				artifactError: null,
				artifacts: [],
			},
		],
	},
};
export const Completed: Story = {
	args: {
		jobs: [
			{
				id: "job-b",
				state: "completed",
				stage: "completed",
				code: "result = 1 + 1",
				cancelRequested: false,
				progress: null,
				result: {
					value: 2,
					stdout: "",
					stderr: "",
					stdoutTruncated: false,
					stderrTruncated: false,
				},
				error: null,
				artifactError: null,
				artifacts: [],
			},
		],
	},
};

export const History: Story = {
	args: {
		jobs: [...Completed.args!.jobs!, ...Running.args!.jobs!],
		selectedJobId: "job-b",
		initialTab: "history",
	},
};
