import { ArtifactRenderer, compileArtifact } from "@eumenes/artifact-ui";
import type {
	Model3dWorkspaceResource,
	Receipt,
	Snapshot,
} from "@eumenes/artifact-ui/contracts";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

afterEach(cleanup);

const asset = {
	id: "a1",
	title: "青緑のロボット",
	tags: ["ロボット"],
	createdAt: "2026-10-18T00:00:00Z",
	prompt: null,
	warnings: ["テクスチャが暗い可能性があります"],
	thumbnailUrl: "/api/model3d/assets/a1/source",
	downloadUrl: "/api/model3d/assets/a1/content",
};
const resource: Model3dWorkspaceResource = {
	kind: "model3d",
	revision: 7,
	available: true,
	generations: [
		{
			id: "g1",
			title: "熊",
			tags: [],
			sourceKind: "prompt",
			state: "running",
			stageLabel: "3Dモデルを生成中",
			assetId: null,
			deleted: false,
			warnings: [],
			errorLabel: null,
		},
		{
			id: "g2",
			title: "犬",
			tags: [],
			sourceKind: "prompt",
			state: "failed",
			stageLabel: "生成失敗",
			assetId: null,
			deleted: false,
			warnings: [],
			errorLabel: "生成の状態を確認できません。状態を再確認してください",
		},
	],
	sourceImages: [{ id: "img1", title: "画像 2026-10-17" }],
	assets: [asset],
	total: 1,
	hasMore: true,
	filter: { q: "", tags: [], sort: "createdAt", order: "desc" },
	selectedAsset: asset,
};
const definition = JSON.stringify({
	view: "model3d-workspace",
	source: "model3d",
	title: "3Dモデル",
});
function setup(
	value: Model3dWorkspaceResource = resource,
	hostViews?: Parameters<typeof ArtifactRenderer>[0]["runtime"]["hostViews"],
) {
	const dispatch = vi.fn(async (): Promise<Receipt> => ({
		status: "accepted",
		message: "",
	}));
	render(
		<ArtifactRenderer
			definition={definition}
			runtime={{ snapshot: { model3d: value }, dispatch, hostViews }}
		/>,
	);
	return dispatch;
}
const last = (dispatch: ReturnType<typeof setup>) =>
	(
		dispatch.mock.calls as unknown as [
			{ action: string; source: string; revision: number; values: unknown },
		][]
	).at(-1)?.[0];

it("compiles only the strict view over a model3d source", () => {
	const snapshot: Snapshot = { model3d: resource };
	expect(compileArtifact(definition, snapshot).request).toMatchObject({
		view: "model3d-workspace",
		source: "model3d",
	});
	expect(() =>
		compileArtifact(definition, {
			model3d: { kind: "music", revision: 0, currentId: "", tracks: [] },
		}),
	).toThrow();
	expect(() => compileArtifact(definition, {})).toThrow();
	expect(() =>
		compileArtifact(
			JSON.stringify({
				view: "model3d-workspace",
				source: "model3d",
				extra: 1,
			}),
			snapshot,
		),
	).toThrow();
	expect(() =>
		compileArtifact(
			JSON.stringify({ view: "model3d-workspace", title: "x" }),
			snapshot,
		),
	).toThrow();
	expect(() =>
		compileArtifact(
			JSON.stringify({
				view: "model3d-workspace",
				source: "model3d",
				url: "https://x",
			}),
			snapshot,
		),
	).toThrow();
});

it("places the host viewer for the selected asset, or says it is unavailable", () => {
	const viewer = vi.fn(({ assetId }: { assetId: string }) => (
		<div>viewer {assetId}</div>
	));
	setup(resource, { "model3d-viewer": viewer });
	fireEvent.keyDown(screen.getByRole("tab", { name: "ライブラリ" }), {
		key: "Enter",
	});
	expect(screen.getByText("viewer a1")).toBeTruthy();
	cleanup();
	setup(resource);
	fireEvent.keyDown(screen.getByRole("tab", { name: "ライブラリ" }), {
		key: "Enter",
	});
	expect(screen.getByText(/利用できません/)).toBeTruthy();
});

it("dispatches generate, cancel and recheck with string values", async () => {
	const dispatch = setup({ ...resource, selectedAsset: undefined });
	fireEvent.change(screen.getByLabelText("タイトル"), {
		target: { value: "熊" },
	});
	// Both tabs stay mounted; the create form's tag field comes first.
	fireEvent.change(screen.getAllByLabelText(/^タグ/)[0]!, {
		target: { value: "動物、木彫り" },
	});
	fireEvent.change(screen.getByLabelText("作りたいもの"), {
		target: { value: "木彫りの熊" },
	});
	fireEvent.click(screen.getByRole("button", { name: "3Dモデルを生成する" }));
	await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
	expect(last(dispatch)).toMatchObject({
		source: "model3d",
		revision: 7,
		action: "model3d-generate",
		values: {
			title: "熊",
			tags: "動物、木彫り",
			prompt: "木彫りの熊",
			imageId: "",
		},
	});
	await waitFor(() =>
		expect((screen.getByLabelText("タイトル") as HTMLInputElement).value).toBe(
			"",
		),
	);
	fireEvent.click(screen.getByRole("button", { name: /生成を取り消す/ }));
	await waitFor(() =>
		expect(last(dispatch)).toMatchObject({
			action: "model3d-cancel",
			values: { id: "g1" },
		}),
	);
	// Only a failed generation offers a recheck.
	expect(screen.getAllByRole("button", { name: /状態を再確認/ })).toHaveLength(
		1,
	);
	fireEvent.click(screen.getByRole("button", { name: /状態を再確認/ }));
	await waitFor(() =>
		expect(last(dispatch)).toMatchObject({
			action: "model3d-recheck",
			values: { id: "g2" },
		}),
	);
});

it("dispatches search, more, select, update and a confirmed delete", async () => {
	const dispatch = setup();
	fireEvent.keyDown(screen.getByRole("tab", { name: "ライブラリ" }), {
		key: "Enter",
	});
	fireEvent.click(screen.getByRole("button", { name: "一覧に戻る" }));
	const search = within(screen.getByRole("search"));
	fireEvent.change(search.getByLabelText("検索"), {
		target: { value: "ロボット" },
	});
	fireEvent.change(search.getByLabelText(/^タグ/), {
		target: { value: "試作、青" },
	});
	fireEvent.change(search.getByLabelText("並び順"), {
		target: { value: "relevance" },
	});
	fireEvent.click(search.getByRole("button", { name: "検索する" }));
	await waitFor(() =>
		expect(last(dispatch)).toMatchObject({
			action: "model3d-search",
			values: {
				query: "ロボット",
				tags: "試作,青",
				sort: "relevance",
				order: "desc",
			},
		}),
	);
	fireEvent.click(screen.getByRole("button", { name: "さらに表示" }));
	await waitFor(() =>
		expect(last(dispatch)).toMatchObject({
			action: "model3d-more",
			values: {},
		}),
	);
	fireEvent.click(screen.getByRole("button", { name: "青緑のロボットを開く" }));
	await waitFor(() =>
		expect(last(dispatch)).toMatchObject({
			action: "model3d-select",
			values: { id: "a1" },
		}),
	);
	const edit = within(
		screen.getByRole("form", { name: "タイトルとタグの編集" }),
	);
	fireEvent.change(edit.getByLabelText("タイトル"), {
		target: { value: "新名" },
	});
	fireEvent.click(screen.getByRole("button", { name: "変更を保存" }));
	await waitFor(() =>
		expect(last(dispatch)).toMatchObject({
			action: "model3d-update",
			values: { id: "a1", title: "新名", tags: "ロボット" },
		}),
	);
	const calls = dispatch.mock.calls.length;
	fireEvent.click(screen.getByRole("button", { name: "削除する" }));
	expect(dispatch.mock.calls.length).toBe(calls);
	fireEvent.click(screen.getByRole("button", { name: "削除を確定" }));
	await waitFor(() =>
		expect(last(dispatch)).toMatchObject({
			action: "model3d-delete",
			values: { id: "a1" },
		}),
	);
});

it("shows the unavailable reason and drops URLs the host did not issue", () => {
	setup({
		...resource,
		generations: [],
		available: false,
		unavailableReason: "LARMに接続できません。",
		assets: [
			{
				...asset,
				thumbnailUrl: "http://evil.example/x.png",
				downloadUrl: "https://evil.example/a.glb",
			},
		],
		selectedAsset: {
			...asset,
			thumbnailUrl: "http://evil.example/x.png",
			downloadUrl: "https://evil.example/a.glb",
		},
	});
	fireEvent.keyDown(screen.getByRole("tab", { name: "作る" }), {
		key: "Enter",
	});
	expect(screen.getByRole("alert").textContent).toContain(
		"LARMに接続できません。",
	);
	fireEvent.keyDown(screen.getByRole("tab", { name: "ライブラリ" }), {
		key: "Enter",
	});
	expect(document.querySelector("img[src^='http://']")).toBeNull();
	expect(screen.queryByRole("link", { name: "GLBをダウンロード" })).toBeNull();
});
