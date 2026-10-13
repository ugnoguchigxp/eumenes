import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ImageGallery } from "./ImageGallery";
afterEach(cleanup);
const image = {
	id: "one",
	title: "森",
	url: "/api/images/one/content",
	width: 512,
	height: 512,
	format: "png" as const,
	createdAt: "2026-10-13T00:00:00Z",
};
it("gallery requires confirmation, allows cancellation and emits only the selected ID", () => {
	const onDelete = vi.fn();
	render(
		<ImageGallery
			images={[image]}
			onRefresh={vi.fn()}
			onSelect={vi.fn()}
			onDelete={onDelete}
		/>,
	);
	fireEvent.click(screen.getByRole("button", { name: "森を削除" }));
	expect(
		screen.getByRole("dialog", { name: "画像を削除しますか？" }),
	).toBeTruthy();
	expect(screen.getByText(/完全に削除/)).toBeTruthy();
	expect(onDelete).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
	expect(onDelete).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "森を削除" }));
	fireEvent.click(screen.getByRole("button", { name: "削除する" }));
	expect(onDelete).toHaveBeenCalledExactlyOnceWith("one");
});
it("pending deletion disables further requests; failed images stay visible with feedback", () => {
	const onDelete = vi.fn();
	const props = {
		images: [image],
		onRefresh: vi.fn(),
		onSelect: vi.fn(),
		onDelete,
	};
	const view = render(<ImageGallery {...props} />);
	fireEvent.click(screen.getByRole("button", { name: "森を削除" }));
	view.rerender(<ImageGallery {...props} pending />);
	expect(screen.getByRole("button", { name: "削除する" })).toHaveProperty(
		"disabled",
		true,
	);
	fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
	view.rerender(
		<ImageGallery {...props} message="削除結果を確認できませんでした。" />,
	);
	expect(screen.getByRole("button", { name: "森を表示" })).toBeTruthy();
	expect(screen.getByText("削除結果を確認できませんでした。")).toBeTruthy();
	expect(onDelete).not.toHaveBeenCalled();
});
it("deleted preview disappears when the authoritative image list changes", () => {
	const props = { onRefresh: vi.fn(), onSelect: vi.fn() };
	const view = render(<ImageGallery {...props} images={[image]} />);
	fireEvent.click(screen.getByRole("button", { name: "森を表示" }));
	expect(screen.getByRole("dialog")).toBeTruthy();
	view.rerender(<ImageGallery {...props} images={[]} />);
	expect(screen.queryByRole("button", { name: "森を表示" })).toBeNull();
	expect(screen.getByText("まだ保存された画像はありません。")).toBeTruthy();
});
