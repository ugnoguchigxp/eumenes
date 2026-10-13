import type { Meta, StoryObj } from "@storybook/react";
import { ImageWorkspace } from "./ImageWorkspace";
const sample =
	"data:image/svg+xml," +
	encodeURIComponent(
		'<svg xmlns="http://www.w3.org/2000/svg" width="768" height="512"><rect width="768" height="512" fill="#d6dfd6"/><path d="M0 420L230 200L430 360L570 140L768 420V512H0" fill="#647b6b"/></svg>',
	);
const meta = {
	title: "Artifacts/ImageWorkspace",
	component: ImageWorkspace,
	args: {
		identity: "studio",
		defaults: {
			prompt: "テーマ：朝の光が差し込む書斎\n画風：水彩",
			width: 768,
			height: 512,
			format: "png",
			seed: 42,
		},
		images: [
			{
				id: "room",
				title: "朝の光が差し込む書斎",
				url: sample,
				width: 768,
				height: 512,
				createdAt: "2026-10-13T00:00:00Z",
				format: "png",
			},
		],
		selectedId: "room",
		onGenerate: () => {},
		onRefresh: () => {},
		onSelect: () => {},
		onDelete: () => {},
	},
} satisfies Meta<typeof ImageWorkspace>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Studio: Story = {};
export const Gallery: Story = { args: { initialTab: "history" } };
export const ArtifactPanel: Story = {
	args: { presentation: "embedded" },
	decorators: [
		(Story) => (
			<div style={{ width: "min(100%, 720px)", height: "720px" }}>
				<Story />
			</div>
		),
	],
};
export const Fullscreen: Story = {
	args: { presentation: "fullscreen", onClose: () => {} },
};
export const Generating: Story = {
	args: {
		busy: true,
		status: "running",
		statusTitle: "画像を生成しています",
		canCancel: true,
		onCancel: () => {},
	},
};
export const Failed: Story = {
	args: {
		status: "failed",
		statusTitle: "画像を作成できませんでした",
		error: "保存画像を取得できませんでした。",
	},
};
