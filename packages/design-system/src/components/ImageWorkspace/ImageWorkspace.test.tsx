import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ImageWorkspace, type ImageWorkspaceProps } from "./ImageWorkspace";
afterEach(cleanup);
const defaults = {
	prompt: "森の絵",
	width: 121,
	height: 177,
	format: "png" as const,
	seed: 42,
};
const images = [
	{
		id: "one",
		title: "森",
		url: "/api/images/one/content",
		width: 121,
		height: 177,
		createdAt: "2026-10-13T00:00:00Z",
		format: "png" as const,
	},
	{
		id: "old",
		title: "海",
		url: "/api/images/old/content",
		width: 512,
		height: 512,
		createdAt: "2026-10-12T00:00:00Z",
		format: "png" as const,
	},
];
const props: ImageWorkspaceProps = {
	identity: "one",
	defaults,
	images,
	selectedId: "one",
	onGenerate: vi.fn(),
	onRefresh: vi.fn(),
	onSelect: vi.fn(),
};
it("full-content navigation removes the editor from gallery and preserves edits when returning", () => {
	render(<ImageWorkspace {...props} />);
	fireEvent.change(screen.getByLabelText("画像作成プロンプト"), {
		target: { value: "光の森" },
	});
	fireEvent.click(screen.getByRole("button", { name: "画像一覧" }));
	expect(
		screen.queryByRole("textbox", { name: "画像作成プロンプト" }),
	).toBeNull();
	expect(screen.queryByRole("tab")).toBeNull();
	expect(screen.getByRole("button", { name: "森を表示" })).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "画像生成" }));
	expect(screen.getByLabelText("画像作成プロンプト")).toHaveProperty(
		"value",
		"光の森",
	);
	fireEvent.click(screen.getByRole("button", { name: "画像を生成" }));
	expect(props.onGenerate).toHaveBeenCalledWith({
		...defaults,
		prompt: "光の森",
	});
});
it("gallery sorts, downloads and opens nested previews", () => {
	render(<ImageWorkspace {...props} initialTab="history" />);
	expect(
		screen.getByRole("link", { name: "森をダウンロード" }).getAttribute("href"),
	).toBe("/api/images/one/content");
	expect(screen.getAllByRole("button", { name: /を表示/ })[0]).toHaveProperty(
		"ariaLabel",
		"森を表示",
	);
	fireEvent.change(screen.getByLabelText("画像の並び順"), {
		target: { value: "asc" },
	});
	expect(screen.getAllByRole("button", { name: /を表示/ })[0]).toHaveProperty(
		"ariaLabel",
		"海を表示",
	);
	fireEvent.click(screen.getByRole("button", { name: "森を表示" }));
	expect(props.onSelect).toHaveBeenCalledWith("one");
	expect(screen.getByRole("dialog")).toBeTruthy();
});
it("fullscreen dialog uses the same workspace and sends close on Escape", () => {
	const close = vi.fn();
	render(
		<ImageWorkspace {...props} presentation="fullscreen" onClose={close} />,
	);
	expect(screen.getByRole("dialog", { name: "画像生成" })).toBeTruthy();
	fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
	expect(close).toHaveBeenCalledOnce();
});
it("busy state blocks new generation and permits cancellation", () => {
	const cancel = vi.fn();
	render(
		<ImageWorkspace
			{...props}
			busy
			canCancel
			status="running"
			onCancel={cancel}
		/>,
	);
	expect(screen.getByRole("button", { name: "生成処理中" })).toHaveProperty(
		"disabled",
		true,
	);
	fireEvent.click(screen.getByRole("button", { name: "生成を取り消す" }));
	expect(cancel).toHaveBeenCalledOnce();
});

it("failed preview retries only the image load and gallery refresh restores failed thumbnails", () => {
	render(<ImageWorkspace {...props} />);
	fireEvent.error(screen.getByRole("img", { name: "森" }));
	expect(screen.getByRole("alert")).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "画像を再読み込み" }));
	expect(screen.getByRole("img", { name: "森" })).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "画像一覧" }));
	fireEvent.error(screen.getByRole("img", { name: "森" }));
	expect(screen.getByRole("button", { name: "森を表示" })).toHaveProperty(
		"disabled",
		true,
	);
	fireEvent.click(screen.getByRole("button", { name: "一覧を更新" }));
	expect(screen.getByRole("img", { name: "森" })).toBeTruthy();
	expect(props.onRefresh).toHaveBeenCalled();
});
