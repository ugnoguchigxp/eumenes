import type { Meta, StoryObj } from "@storybook/react";
import { ObjectRecognitionWorkspace } from "./ObjectRecognitionWorkspace";
const meta = {
	title: "Components/ObjectRecognitionWorkspace",
	component: ObjectRecognitionWorkspace,
	args: { configured: true, items: [] },
	parameters: { layout: "padded" },
} satisfies Meta<typeof ObjectRecognitionWorkspace>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ReadyForCamera: Story = {};
export const RunningVideo: Story = {
	args: {
		selectedId: "sample",
		items: [
			{
				id: "sample",
				name: "clip.webm",
				mime: "video/webm",
				state: "running",
				progress: { processedFrames: 12, totalFrames: 60 },
				result: null,
				errorCode: null,
			},
		],
	},
};
export const ConnectionRequired: Story = { args: { configured: false } };
