import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ImagePicker, type ImagePickerUploadResult } from "./ImagePicker";
afterEach(cleanup);
const images = [
	{ id: "a", title: "森", thumbnailUrl: "/forest.png" },
	{ id: "b", title: "海", thumbnailUrl: "/sea.png" },
];

it("separates selection, embedded preview and confirmation; cancel emits no selection", () => {
	const onConfirm = vi.fn();
	const onCancel = vi.fn();
	render(
		<ImagePicker
			images={images}
			selectedId="a"
			onConfirm={onConfirm}
			onCancel={onCancel}
		/>,
	);
	fireEvent.click(screen.getByRole("button", { name: "海を拡大" }));
	expect(screen.getByRole("img", { name: "海" })).toBeTruthy();
	expect(screen.queryByRole("dialog")).toBeNull();
	expect(onConfirm).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "画像一覧に戻る" }));
	expect(screen.getByRole("button", { name: "森を選ぶ" })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	fireEvent.click(screen.getByRole("button", { name: "海を選ぶ" }));
	expect(onConfirm).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "この画像を使う" }));
	expect(onConfirm).toHaveBeenCalledExactlyOnceWith("b");
	fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
	expect(onCancel).toHaveBeenCalledTimes(1);
});

it("keeps the loaded images and selection when returning from a preview", () => {
	const manyImages = Array.from({ length: 25 }, (_, index) => ({
		id: String(index),
		title: `画像${index}`,
		thumbnailUrl: `/image/${index}`,
	}));
	render(
		<ImagePicker images={manyImages} onConfirm={vi.fn()} onCancel={vi.fn()} />,
	);
	fireEvent.click(screen.getByRole("button", { name: "画像をさらに表示" }));
	fireEvent.click(screen.getByRole("button", { name: "画像24を選ぶ" }));
	fireEvent.click(screen.getByRole("button", { name: "画像24を拡大" }));
	fireEvent.click(screen.getByRole("button", { name: "画像一覧に戻る" }));
	expect(screen.getByRole("button", { name: "画像24を選ぶ" })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
});

it("uses the image to preview and the circle to select; deletion requires confirmation", async () => {
	const onDelete = vi.fn().mockResolvedValue(true);
	const onConfirm = vi.fn();
	const view = render(
		<ImagePicker
			images={images}
			onDelete={onDelete}
			onConfirm={onConfirm}
			onCancel={vi.fn()}
		/>,
	);
	expect(
		screen.getByRole("link", { name: "森をダウンロード" }),
	).toHaveAttribute("href", "/forest.png");
	fireEvent.click(screen.getByRole("button", { name: "森を選ぶ" }));
	expect(screen.getByRole("button", { name: "森を選ぶ" })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	fireEvent.click(screen.getByRole("button", { name: "森を拡大" }));
	expect(screen.getByRole("button", { name: "画像一覧に戻る" })).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "画像一覧に戻る" }));
	fireEvent.click(screen.getByRole("button", { name: "森を削除" }));
	expect(onDelete).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
	expect(onDelete).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "森を削除" }));
	fireEvent.click(screen.getByRole("button", { name: "削除する" }));
	await waitFor(() => expect(onDelete).toHaveBeenCalledExactlyOnceWith("a"));
	await waitFor(() =>
		expect(
			screen.getByRole("button", { name: "この画像を使う" }),
		).toBeDisabled(),
	);
	view.rerender(
		<ImagePicker
			images={[images[1]!]}
			onDelete={onDelete}
			onConfirm={onConfirm}
			onCancel={vi.fn()}
		/>,
	);
	expect(screen.queryByRole("button", { name: "森を選ぶ" })).toBeNull();
});

it("keeps the selection and reports an unconfirmed deletion", async () => {
	const onDelete = vi.fn().mockResolvedValue(false);
	render(
		<ImagePicker
			images={images}
			selectedId="a"
			onDelete={onDelete}
			onConfirm={vi.fn()}
			onCancel={vi.fn()}
		/>,
	);
	fireEvent.click(screen.getByRole("button", { name: "森を削除" }));
	fireEvent.click(screen.getByRole("button", { name: "削除する" }));
	await waitFor(() =>
		expect(screen.getByRole("alert")).toHaveTextContent(
			"削除結果を確認できませんでした",
		),
	);
	fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
	expect(screen.getByRole("button", { name: "森を選ぶ" })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
});

it("does not confirm a removed candidate or an indeterminate library", () => {
	const onConfirm = vi.fn();
	const props = { images, selectedId: "a", onConfirm, onCancel: vi.fn() };
	const view = render(<ImagePicker {...props} />);
	view.rerender(<ImagePicker {...props} images={[]} />);
	expect(screen.getByRole("button", { name: "この画像を使う" })).toBeDisabled();
	view.rerender(<ImagePicker {...props} error="一覧を取得できません" />);
	fireEvent.click(screen.getByRole("button", { name: "この画像を使う" }));
	expect(onConfirm).not.toHaveBeenCalled();
	expect(screen.getByRole("button", { name: "参照…" })).toBeEnabled();
	expect(screen.getAllByRole("tab")).toHaveLength(2);
	fireEvent.keyDown(screen.getByRole("tab", { name: "Googleフォト" }), {
		key: "Enter",
	});
	expect(screen.getByRole("status")).toHaveTextContent("利用できません");
	expect(screen.queryByRole("button", { name: "森を選ぶ" })).toBeNull();
});

it("opens 参照… outside the provider tabs and never confirms a local file as a LARM reference", () => {
	const create = vi
		.spyOn(URL, "createObjectURL")
		.mockReturnValue("blob:preview");
	const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
	const onConfirm = vi.fn();
	const view = render(
		<ImagePicker
			images={images}
			selectedId="a"
			onConfirm={onConfirm}
			onCancel={vi.fn()}
		/>,
	);
	const input = screen.getByLabelText("アップロードする画像");
	const open = vi.spyOn(input, "click");
	fireEvent.click(screen.getByRole("button", { name: "参照…" }));
	expect(open).toHaveBeenCalledTimes(1);
	const file = new File(["image"], "photo.png", { type: "image/png" });
	fireEvent.change(input, { target: { files: [file] } });
	expect(create).toHaveBeenCalledWith(file);
	expect(screen.getByRole("img", { name: "photo.png" })).toHaveAttribute(
		"src",
		"blob:preview",
	);
	expect(screen.getByRole("status")).toHaveTextContent("未アップロード");
	expect(screen.getByRole("button", { name: "この画像を使う" })).toBeDisabled();
	fireEvent.click(screen.getByRole("button", { name: "この画像を使う" }));
	expect(onConfirm).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "海を選ぶ" }));
	expect(revoke).toHaveBeenCalledWith("blob:preview");
	expect(screen.getByRole("button", { name: "この画像を使う" })).toBeEnabled();
	fireEvent.click(screen.getByRole("button", { name: "この画像を使う" }));
	expect(onConfirm).toHaveBeenCalledExactlyOnceWith("b");
	view.unmount();
	vi.restoreAllMocks();
});

it("can retry a broken thumbnail by refreshing the list", () => {
	const onRefresh = vi.fn();
	render(
		<ImagePicker
			images={images}
			onConfirm={vi.fn()}
			onCancel={vi.fn()}
			onRefresh={onRefresh}
		/>,
	);
	fireEvent.error(
		screen.getByRole("button", { name: "森を拡大" }).querySelector("img")!,
	);
	expect(screen.getByRole("button", { name: "森を選ぶ" })).toBeDisabled();
	fireEvent.click(screen.getByRole("button", { name: "一覧を更新" }));
	expect(onRefresh).toHaveBeenCalledTimes(1);
	expect(screen.getByRole("button", { name: "森を選ぶ" })).not.toBeDisabled();
});

it("uploads only on explicit action, reconciles with the same UUID, and confirms the imported ID separately", async () => {
	vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview");
	vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
	const onConfirm = vi.fn();
	const onUpload = vi
		.fn()
		.mockResolvedValueOnce({ status: "pending", message: "未確認" })
		.mockResolvedValueOnce({
			status: "succeeded",
			image: {
				id: "imported",
				title: "取り込んだ画像",
				thumbnailUrl: "/imported",
			},
		});
	render(
		<ImagePicker
			images={images}
			onConfirm={onConfirm}
			onCancel={() => {}}
			onUpload={onUpload}
		/>,
	);
	const file = new File(["image"], "photo.png", { type: "image/png" });
	fireEvent.change(screen.getByLabelText("アップロードする画像"), {
		target: { files: [file] },
	});
	expect(onUpload).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: /^アップロード$/ }));
	await waitFor(() =>
		expect(screen.getByRole("button", { name: "状態を再確認" })).toBeEnabled(),
	);
	const first = onUpload.mock.calls[0]!;
	expect(first[0]).toBe(file);
	fireEvent.click(screen.getByRole("button", { name: "状態を再確認" }));
	await waitFor(() =>
		expect(
			screen.getByRole("button", { name: "この画像を使う" }),
		).toBeEnabled(),
	);
	expect(onUpload.mock.calls[1]![1]).toBe(first[1]);
	expect(onConfirm).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "この画像を使う" }));
	expect(onConfirm).toHaveBeenCalledWith("imported");
	vi.restoreAllMocks();
});
it("discarding a file aborts its upload and ignores a late successful result", async () => {
	vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview");
	vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
	let finish!: (value: ImagePickerUploadResult) => void;
	const onUpload = vi.fn(
		(_file: File, _id: string, _signal: AbortSignal) =>
			new Promise<ImagePickerUploadResult>((r) => (finish = r)),
	);
	render(
		<ImagePicker
			images={images}
			onConfirm={() => {}}
			onCancel={() => {}}
			onUpload={onUpload}
		/>,
	);
	fireEvent.change(screen.getByLabelText("アップロードする画像"), {
		target: {
			files: [new File(["image"], "photo.png", { type: "image/png" })],
		},
	});
	fireEvent.click(screen.getByRole("button", { name: /^アップロード$/ }));
	fireEvent.click(screen.getByRole("button", { name: "ファイル選択を解除" }));
	expect(onUpload.mock.calls[0]?.[2].aborted).toBe(true);
	finish({ status: "succeeded", image: { id: "late", title: "old" } });
	await waitFor(() =>
		expect(
			screen.getByRole("button", { name: "この画像を使う" }),
		).toBeDisabled(),
	);
	vi.restoreAllMocks();
});
