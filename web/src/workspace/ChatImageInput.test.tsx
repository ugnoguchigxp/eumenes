import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ChatImageInput } from "./ChatImageInput";
import type { WorkspaceState } from "./useWorkspace";

beforeEach(() => {
	// The menu re-places itself on resize; jsdom has no layout to observe.
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			disconnect() {}
		},
	);
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});
const images = [
	{ id: "a", title: "画像A", thumbnailUrl: "/api/images/a/content" },
	{ id: "b", title: "画像B", thumbnailUrl: "/api/images/b/content" },
	{ id: "c", title: "画像C", thumbnailUrl: "/api/images/c/content" },
];
function state(count = 0) {
	const attachments = {
		items: Array.from({ length: count }, (_, i) =>
			i === 0
				? { id: "0", source: { kind: "library", imageId: "c" } }
				: { id: String(i), source: { kind: "file" } },
		),
		busy: false,
		add: vi.fn(),
		addLibrary: vi.fn(),
		library: { images, loading: false, open: vi.fn(), refresh: vi.fn() },
	};
	return {
		attachments,
		value: {
			attachments,
			submit: { isPending: false },
		} as unknown as WorkspaceState,
	};
}

test("the attach button offers device files and the image library", async () => {
	const s = state(1);
	const click = vi.spyOn(HTMLInputElement.prototype, "click");
	render(<ChatImageInput state={s.value} />);
	fireEvent.click(screen.getByRole("button", { name: "ファイルを添付" }));
	expect(click).not.toHaveBeenCalled();
	fireEvent.click(
		await screen.findByRole("menuitem", { name: "端末の画像を選ぶ…" }),
	);
	expect(click).toHaveBeenCalledOnce();
	expect(screen.queryByRole("dialog")).toBeNull();
	fireEvent.click(screen.getByRole("button", { name: "ファイルを添付" }));
	fireEvent.click(
		await screen.findByRole("menuitem", { name: "画像一覧から選ぶ…" }),
	);
	expect(s.attachments.library.open).toHaveBeenCalledOnce();
	expect(screen.getByRole("dialog", { name: "画像一覧から添付" })).toBeTruthy();
	// The saved image already in the draft cannot be chosen twice.
	expect(
		screen.getByRole<HTMLButtonElement>("button", { name: "画像Cを選ぶ" })
			.disabled,
	).toBe(true);
	expect(screen.getByText("添付済み")).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "画像Bを選ぶ" }));
	fireEvent.click(screen.getByRole("button", { name: "画像Aを選ぶ" }));
	fireEvent.click(screen.getByRole("button", { name: "選んだ画像を使う" }));
	expect(s.attachments.addLibrary).toHaveBeenCalledExactlyOnceWith([
		images[1],
		images[0],
	]);
	expect(screen.queryByRole("dialog")).toBeNull();
	click.mockRestore();
});

test("a full draft explains the limit instead of offering more images", async () => {
	const s = state(8);
	render(<ChatImageInput state={s.value} />);
	fireEvent.click(screen.getByRole("button", { name: "ファイルを添付" }));
	fireEvent.click(
		await screen.findByRole("menuitem", { name: "画像一覧から選ぶ…" }),
	);
	expect(
		screen.getByText("添付は8枚までです。添付を外してから選んでください。"),
	).toBeTruthy();
	expect(screen.queryByRole("button", { name: "選んだ画像を使う" })).toBeNull();
});
