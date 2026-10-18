import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ImagePicker } from "./ImagePicker";
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
	expect(screen.getByRole("status")).toHaveTextContent("未実装");
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
		screen.getByRole("button", { name: "森を選ぶ" }).querySelector("img")!,
	);
	expect(screen.getByRole("button", { name: "森を選ぶ" })).toBeDisabled();
	fireEvent.click(screen.getByRole("button", { name: "一覧を更新" }));
	expect(onRefresh).toHaveBeenCalledTimes(1);
	expect(screen.getByRole("button", { name: "森を選ぶ" })).not.toBeDisabled();
});
