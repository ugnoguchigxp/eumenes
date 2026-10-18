import type { Meta, StoryObj } from "@storybook/react";
import { Model3dWorkspace } from "./Model3dWorkspace";
import type { Model3dWorkspaceProps } from "./types";

const thumb =
	"data:image/svg+xml," +
	encodeURIComponent(
		'<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#d6dfd6"/><circle cx="128" cy="110" r="52" fill="#647b6b"/><rect x="76" y="160" width="104" height="60" rx="12" fill="#647b6b"/></svg>',
	);
const asset = {
	id: "a1",
	title: "青緑のロボット",
	tags: ["ロボット", "試作"],
	createdAt: "2026-10-18T01:00:00Z",
	prompt: "青緑色の小さなロボット",
	warnings: ["テクスチャが暗い可能性があります"],
	thumbnailUrl: thumb,
	downloadUrl: "/api/model3d/assets/a1/content",
};
const args: Model3dWorkspaceProps = {
	available: true,
	generations: [
		{
			id: "g1",
			title: "木彫りの熊",
			tags: [],
			sourceKind: "prompt",
			prompt: "木彫りの熊",
			state: "running",
			stageLabel: "3Dモデルを生成中",
			assetId: null,
			deleted: false,
			warnings: [],
			errorLabel: null,
		},
		{
			id: "g2",
			title: "青緑のロボット",
			tags: ["ロボット"],
			sourceKind: "prompt",
			state: "completed",
			stageLabel: "生成完了",
			assetId: "a1",
			deleted: false,
			warnings: ["テクスチャが暗い可能性があります"],
			errorLabel: null,
		},
	],
	sourceImages: [{ id: "i1", title: "ロボットの絵", thumbnailUrl: thumb }],
	assets: [asset],
	total: 1,
	hasMore: false,
	filter: { q: "", tags: [], sort: "createdAt", order: "desc" },
	selectedAsset: asset,
	renderViewer: () => (
		<div style={{ padding: "2rem" }}>3Dビューア（ホストが表示）</div>
	),
	onGenerate: () => true,
	onCancel: () => {},
	onRecheck: () => {},
	onSelect: () => {},
	onDelete: () => {},
	onUpdate: () => true,
	onSearch: () => {},
	onMore: () => {},
	onRefresh: () => {},
};
const meta = {
	title: "Artifacts/Model3dWorkspace",
	component: Model3dWorkspace,
	args,
} satisfies Meta<typeof Model3dWorkspace>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Library: Story = {};
export const Empty: Story = {
	args: { generations: [], assets: [], total: 0, selectedAsset: undefined },
};
export const Unavailable: Story = {
	args: { available: false, unavailableReason: "LARMに接続できません。" },
};
export const Failed: Story = {
	args: {
		selectedAsset: undefined,
		generations: [
			{
				id: "g3",
				title: "失敗した生成",
				tags: [],
				sourceKind: "prompt",
				state: "failed",
				stageLabel: "生成失敗",
				assetId: null,
				deleted: false,
				warnings: [],
				errorLabel: "LARM側で停止の確認が必要です",
			},
		],
	},
};
export const Loading: Story = { args: { loading: true, assets: [] } };
