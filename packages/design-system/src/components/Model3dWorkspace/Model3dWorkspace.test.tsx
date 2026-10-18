import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Model3dWorkspace } from "./Model3dWorkspace";
import type {
	Model3dAssetItem,
	Model3dGenerationItem,
	Model3dWorkspaceProps,
} from "./types";

const asset: Model3dAssetItem = {
	id: "a1",
	title: "青緑のロボット",
	tags: ["ロボット"],
	createdAt: "2026-10-18T01:00:00Z",
	prompt: "青緑色のロボット",
	warnings: ["テクスチャが暗い可能性があります"],
	downloadUrl: "/api/model3d/assets/a1/content",
};
function generation(
	patch: Partial<Model3dGenerationItem>,
): Model3dGenerationItem {
	return {
		id: "g1",
		title: "木彫りの熊",
		tags: [],
		sourceKind: "prompt",
		state: "running",
		stageLabel: "3Dモデルを生成中",
		assetId: null,
		deleted: false,
		warnings: [],
		errorLabel: null,
		...patch,
	};
}
function props(patch: Partial<Model3dWorkspaceProps> = {}) {
	return {
		available: true,
		generations: [],
		sourceImages: [{ id: "i1", title: "ロボットの絵" }],
		assets: [asset],
		total: 1,
		hasMore: false,
		filter: { q: "", tags: [], sort: "createdAt", order: "desc" },
		onGenerate: vi.fn(() => true),
		onCancel: vi.fn(),
		onRecheck: vi.fn(),
		onSelect: vi.fn(),
		onDelete: vi.fn(),
		onUpdate: vi.fn(() => true),
		onSearch: vi.fn(),
		onMore: vi.fn(),
		onRefresh: vi.fn(),
		...patch,
	} satisfies Model3dWorkspaceProps;
}
afterEach(() => vi.restoreAllMocks());

describe("Model3dWorkspace generation", () => {
	it("rejects an empty form and sends a prompt generation", async () => {
		const user = userEvent.setup();
		const p = props();
		render(<Model3dWorkspace {...p} />);
		await user.click(
			screen.getByRole("button", { name: "3Dモデルを生成する" }),
		);
		expect(screen.getByText("タイトルを入力してください。")).toBeTruthy();
		expect(p.onGenerate).not.toHaveBeenCalled();
		await user.type(screen.getByLabelText("タイトル"), " 熊 ");
		await user.click(
			screen.getByRole("button", { name: "3Dモデルを生成する" }),
		);
		expect(
			screen.getByText("作りたいものを文章で入力してください。"),
		).toBeTruthy();
		// Both tabs stay mounted; the create form's tag field comes first.
		await user.type(screen.getAllByLabelText(/^タグ/)[0]!, "動物、木彫り");
		await user.type(screen.getByLabelText("作りたいもの"), "木彫りの熊");
		await user.click(
			screen.getByRole("button", { name: "3Dモデルを生成する" }),
		);
		expect(p.onGenerate).toHaveBeenCalledWith({
			title: "熊",
			tags: "動物、木彫り",
			prompt: "木彫りの熊",
			imageId: "",
		});
		await waitFor(() =>
			expect(
				(screen.getByLabelText("タイトル") as HTMLInputElement).value,
			).toBe(""),
		);
	});

	it("keeps the form when the host does not accept the request", async () => {
		const user = userEvent.setup();
		const p = props({ onGenerate: vi.fn(() => false) });
		render(<Model3dWorkspace {...p} />);
		await user.type(screen.getByLabelText("タイトル"), "熊");
		await user.type(screen.getByLabelText("作りたいもの"), "木彫りの熊");
		await user.click(
			screen.getByRole("button", { name: "3Dモデルを生成する" }),
		);
		expect(p.onGenerate).toHaveBeenCalledTimes(1);
		expect((screen.getByLabelText("タイトル") as HTMLInputElement).value).toBe(
			"熊",
		);
	});

	it("sends a chosen source image instead of a prompt", async () => {
		const user = userEvent.setup();
		const p = props();
		render(<Model3dWorkspace {...p} />);
		await user.type(screen.getByLabelText("タイトル"), "絵から");
		await user.click(screen.getByLabelText("保存した画像から作る"));
		await user.click(
			screen.getByRole("button", { name: "3Dモデルを生成する" }),
		);
		expect(screen.getByText("元にする画像を選んでください。")).toBeTruthy();
		await user.click(screen.getByRole("button", { name: "画像を選ぶ" }));
		await user.click(
			screen.getByRole("button", { name: "ロボットの絵を選ぶ" }),
		);
		expect(p.onGenerate).not.toHaveBeenCalled();
		await user.click(screen.getByRole("button", { name: "この画像を使う" }));
		await user.click(
			screen.getByRole("button", { name: "3Dモデルを生成する" }),
		);
		expect(p.onGenerate).toHaveBeenCalledWith({
			title: "絵から",
			tags: "",
			prompt: "",
			imageId: "i1",
		});
	});

	it("disables the form and says why when unavailable", () => {
		render(
			<Model3dWorkspace
				{...props({
					available: false,
					unavailableReason: "LARMに接続できません。",
				})}
			/>,
		);
		expect(screen.getByRole("alert").textContent).toContain(
			"LARMに接続できません。",
		);
		expect(
			screen.getByRole("button", { name: "3Dモデルを生成する" }),
		).toHaveProperty("disabled", true);
	});
});

describe("Model3dWorkspace generations", () => {
	it("shows the stage label without any percentage and offers only cancel while running", async () => {
		const user = userEvent.setup();
		const p = props({ generations: [generation({})] });
		const { container } = render(<Model3dWorkspace {...p} />);
		expect(screen.getByText("3Dモデルを生成中")).toBeTruthy();
		expect(container.textContent).not.toMatch(/\d\s*%/);
		expect(container.querySelector("progress")).toBeNull();
		await user.click(screen.getByRole("button", { name: /生成を取り消す/ }));
		expect(screen.queryByRole("button", { name: /状態を再確認/ })).toBeNull();
		expect(p.onCancel).toHaveBeenCalledWith("g1");
	});

	it("offers only recheck for a failed generation and shows the reason", () => {
		render(
			<Model3dWorkspace
				{...props({
					generations: [
						generation({
							state: "failed",
							stageLabel: "生成失敗",
							errorLabel: "LARM側で停止の確認が必要です",
						}),
					],
				})}
			/>,
		);
		expect(screen.getByText(/LARM側で停止の確認が必要です/)).toBeTruthy();
		expect(screen.queryByRole("button", { name: /取り消す/ })).toBeNull();
		expect(screen.getByRole("button", { name: /状態を再確認/ })).toBeTruthy();
	});

	it("opens a completed model and says when it was deleted", async () => {
		const user = userEvent.setup();
		const p = props({
			generations: [
				generation({
					id: "g2",
					state: "completed",
					stageLabel: "生成完了",
					assetId: "a1",
					warnings: ["顔が崩れている可能性があります"],
				}),
				generation({
					id: "g3",
					title: "消した作品",
					state: "completed",
					stageLabel: "完成品は削除済み",
					deleted: true,
				}),
			],
		});
		render(<Model3dWorkspace {...p} />);
		expect(screen.getByText("顔が崩れている可能性があります")).toBeTruthy();
		expect(
			screen.getByText("完成した3Dモデルは削除されています。"),
		).toBeTruthy();
		await user.click(screen.getByRole("button", { name: /を表示する/ }));
		expect(p.onSelect).toHaveBeenCalledWith("a1");
	});

	it("marks the highlighted generation", () => {
		render(
			<Model3dWorkspace
				{...props({
					generations: [generation({})],
					highlightedGenerationId: "g1",
				})}
			/>,
		);
		expect(
			screen
				.getByText("木彫りの熊")
				.closest("li")
				?.getAttribute("aria-current"),
		).toBe("true");
	});
});

describe("Model3dWorkspace library", () => {
	async function openLibrary(p: ReturnType<typeof props>) {
		const user = userEvent.setup();
		render(<Model3dWorkspace {...p} />);
		await user.click(screen.getByRole("tab", { name: "ライブラリ" }));
		return user;
	}

	it("searches with parsed tags, sort and order", async () => {
		const p = props();
		const user = await openLibrary(p);
		const search = within(screen.getByRole("search"));
		await user.type(search.getByLabelText("検索"), "ロボット");
		await user.type(search.getByLabelText(/^タグ/), "試作、 青 ,試作");
		await user.selectOptions(search.getByLabelText("並び順"), "relevance");
		await user.click(screen.getByRole("button", { name: "検索する" }));
		expect(p.onSearch).toHaveBeenCalledWith({
			q: "ロボット",
			tags: ["試作", "青"],
			sort: "relevance",
			order: "desc",
		});
		await user.selectOptions(search.getByLabelText("並び順"), "asc");
		await user.click(screen.getByRole("button", { name: "検索する" }));
		expect(p.onSearch).toHaveBeenLastCalledWith(
			expect.objectContaining({ sort: "createdAt", order: "asc" }),
		);
	});

	it("shows results, selects one and pages with more", async () => {
		const p = props({ hasMore: true });
		const user = await openLibrary(p);
		expect(screen.getByText("1件")).toBeTruthy();
		await user.click(
			screen.getByRole("button", { name: "青緑のロボットを開く" }),
		);
		expect(p.onSelect).toHaveBeenCalledWith("a1");
		await user.click(screen.getByRole("button", { name: "一覧に戻る" }));
		await user.click(screen.getByRole("button", { name: "さらに表示" }));
		expect(p.onMore).toHaveBeenCalledTimes(1);
	});

	it("follows the applied filter from the host", async () => {
		const p = props();
		const user = userEvent.setup();
		const { rerender } = render(<Model3dWorkspace {...p} />);
		await user.click(screen.getByRole("tab", { name: "ライブラリ" }));
		rerender(
			<Model3dWorkspace
				{...p}
				filter={{ q: "犬", tags: ["動物"], sort: "createdAt", order: "desc" }}
			/>,
		);
		const search = within(screen.getByRole("search"));
		expect((search.getByLabelText("検索") as HTMLInputElement).value).toBe(
			"犬",
		);
		expect((search.getByLabelText(/^タグ/) as HTMLInputElement).value).toBe(
			"動物",
		);
	});

	it("shows an error with retry and an empty message", async () => {
		const p = props({ assets: [], total: 0, error: "取得できませんでした。" });
		const user = await openLibrary(p);
		expect(screen.getByRole("alert").textContent).toContain(
			"取得できませんでした。",
		);
		await user.click(screen.getByRole("button", { name: "再試行" }));
		expect(p.onRefresh).toHaveBeenCalledTimes(1);
	});
});

describe("Model3dWorkspace detail", () => {
	it("a background refresh of the same host request does not reset detail scrolling", () => {
		const p = props({ selectedAsset: asset });
		const content = () => (
			<div style={{ overflowY: "auto" }} data-testid="scroll-owner">
				<Model3dWorkspace {...p} focus={{ seq: 1, kind: "asset" }} />
			</div>
		);
		const view = render(content());
		const owner = screen.getByTestId("scroll-owner");
		owner.scrollTop = 120;
		view.rerender(content());
		expect(owner.scrollTop).toBe(120);
	});

	it("host search opens the grid from detail; generation and repeated asset requests retain their meaning", async () => {
		const user = userEvent.setup();
		const p = props({ selectedAsset: asset, highlightedGenerationId: "g1" });
		const view = render(
			<Model3dWorkspace {...p} focus={{ seq: 1, kind: "asset" }} />,
		);
		expect(screen.getByRole("button", { name: "一覧に戻る" })).toBeTruthy();
		view.rerender(
			<Model3dWorkspace
				{...p}
				focus={{ seq: 2, kind: "search" }}
				filter={{ ...p.filter, q: "検索結果" }}
			/>,
		);
		expect(screen.getByRole("search")).toBeTruthy();
		expect(screen.getByRole("textbox", { name: "検索" })).toHaveProperty(
			"value",
			"検索結果",
		);
		expect(
			screen.queryByRole("region", { name: "モデルの拡大詳細" }),
		).toBeNull();
		await user.click(
			screen.getByRole("button", { name: "青緑のロボットを開く" }),
		);
		expect(screen.getByRole("button", { name: "一覧に戻る" })).toBeTruthy();
		view.rerender(
			<Model3dWorkspace {...p} focus={{ seq: 3, kind: "generation" }} />,
		);
		expect(screen.getByRole("form", { name: "3Dモデルの生成" })).toBeTruthy();
		view.rerender(
			<Model3dWorkspace {...p} focus={{ seq: 4, kind: "asset" }} />,
		);
		expect(
			screen.getByRole("region", { name: "モデルの拡大詳細" }),
		).toBeTruthy();
	});

	it("returns to the grid without losing search or the create draft, and reopens on a repeated host request", async () => {
		const user = userEvent.setup();
		const p = props();
		const view = render(<Model3dWorkspace {...p} />);
		await user.type(
			screen.getByRole("textbox", { name: "タイトル" }),
			"作成中の作品",
		);
		await user.click(screen.getByRole("tab", { name: "ライブラリ" }));
		expect(screen.queryByRole("form", { name: "3Dモデルの生成" })).toBeNull();
		await user.type(
			screen.getByRole("textbox", { name: "検索" }),
			"入力中の検索",
		);
		await user.click(
			screen.getByRole("button", { name: "青緑のロボットを開く" }),
		);
		view.rerender(
			<Model3dWorkspace
				{...p}
				selectedAsset={asset}
				focus={{ seq: 1, kind: "asset" }}
			/>,
		);
		expect(screen.queryByRole("search")).toBeNull();
		expect(
			screen.getByRole("region", { name: "モデルの拡大詳細" }),
		).toBeTruthy();
		await user.click(screen.getByRole("button", { name: "一覧に戻る" }));
		expect(screen.getByRole("textbox", { name: "検索" })).toHaveProperty(
			"value",
			"入力中の検索",
		);
		view.rerender(
			<Model3dWorkspace
				{...p}
				selectedAsset={asset}
				focus={{ seq: 2, kind: "asset" }}
			/>,
		);
		expect(screen.getByRole("button", { name: "一覧に戻る" })).toBeTruthy();
		await user.click(screen.getByRole("tab", { name: "作る" }));
		expect(screen.getByRole("textbox", { name: "タイトル" })).toHaveProperty(
			"value",
			"作成中の作品",
		);
	});

	it("cancelling the image picker preserves the confirmed image and all form fields", async () => {
		const user = userEvent.setup();
		const p = props({
			sourceImages: [
				{ id: "i1", title: "ロボット" },
				{ id: "i2", title: "熊" },
			],
		});
		render(<Model3dWorkspace {...p} />);
		await user.type(
			screen.getByRole("textbox", { name: "タイトル" }),
			"制作途中",
		);
		await user.click(screen.getByLabelText("保存した画像から作る"));
		await user.click(screen.getByRole("button", { name: "画像を選ぶ" }));
		await user.click(screen.getByRole("button", { name: "ロボットを選ぶ" }));
		await user.click(screen.getByRole("button", { name: "この画像を使う" }));
		await user.click(screen.getByRole("button", { name: "画像を変更" }));
		await user.click(screen.getByRole("button", { name: "熊を選ぶ" }));
		await user.click(screen.getByRole("button", { name: "キャンセル" }));
		await user.click(
			screen.getByRole("button", { name: "3Dモデルを生成する" }),
		);
		expect(p.onGenerate).toHaveBeenCalledWith({
			title: "制作途中",
			tags: "",
			prompt: "",
			imageId: "i1",
		});
	});

	function detail(p = props({ selectedAsset: asset })) {
		const viewer = vi.fn((id: string) => <div>viewer:{id}</div>);
		render(<Model3dWorkspace {...p} renderViewer={viewer} />);
		return { p, viewer };
	}

	it("opens on the library with the viewer, warnings, note and GLB link", () => {
		detail();
		expect(screen.getByText("viewer:a1")).toBeTruthy();
		expect(screen.getByText("テクスチャが暗い可能性があります")).toBeTruthy();
		expect(screen.getByText(/Blender 4\.0 以上/)).toBeTruthy();
		const link = screen.getByRole("link", { name: "GLBをダウンロード" });
		expect(link.getAttribute("href")).toBe("/api/model3d/assets/a1/content");
	});

	it("saves edited title and tags only when changed", async () => {
		const user = userEvent.setup();
		const { p } = detail();
		const form = screen.getByRole("form", { name: "タイトルとタグの編集" });
		const save = within(form).getByRole("button", { name: "変更を保存" });
		expect(save).toHaveProperty("disabled", true);
		const title = within(form).getByLabelText("タイトル");
		await user.clear(title);
		await user.type(title, "新しい名前");
		await user.click(save);
		expect(p.onUpdate).toHaveBeenCalledWith({
			id: "a1",
			title: "新しい名前",
			tags: "ロボット",
		});
	});

	it("deletes only after the confirmation step and can cancel it", async () => {
		const user = userEvent.setup();
		const { p } = detail();
		await user.click(screen.getByRole("button", { name: "削除する" }));
		expect(p.onDelete).not.toHaveBeenCalled();
		expect(screen.getByRole("alertdialog")).toBeTruthy();
		await user.click(screen.getByRole("button", { name: "キャンセル" }));
		expect(screen.queryByRole("alertdialog")).toBeNull();
		expect(p.onDelete).not.toHaveBeenCalled();
		await user.click(screen.getByRole("button", { name: "削除する" }));
		await user.click(screen.getByRole("button", { name: "削除を確定" }));
		expect(p.onDelete).toHaveBeenCalledWith("a1");
	});

	it("moves to the library when the host selects an asset", () => {
		const p = props();
		const { rerender } = render(<Model3dWorkspace {...p} />);
		expect(
			screen.getByRole("tab", { name: "作る" }).getAttribute("data-state"),
		).toBe("active");
		rerender(<Model3dWorkspace {...p} selectedAsset={asset} />);
		expect(
			screen
				.getByRole("tab", { name: "ライブラリ" })
				.getAttribute("data-state"),
		).toBe("active");
	});
});
