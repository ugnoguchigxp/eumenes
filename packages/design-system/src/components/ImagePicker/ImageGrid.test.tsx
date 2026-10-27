import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ImageGrid } from "./ImageGrid";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

it("loads image content in batches as the end of the grid becomes visible", () => {
	let intersect!: IntersectionObserverCallback;
	const disconnect = vi.fn();
	vi.stubGlobal(
		"IntersectionObserver",
		class {
			constructor(callback: IntersectionObserverCallback) {
				intersect = callback;
			}
			observe() {}
			disconnect() {
				disconnect();
			}
		},
	);
	const images = Array.from({ length: 45 }, (_, index) => ({
		id: String(index),
		title: `画像${index}`,
		thumbnailUrl: `/image/${index}`,
	}));
	render(<ImageGrid images={images} onSelect={() => {}} />);
	expect(screen.getAllByRole("img")).toHaveLength(20);
	expect(screen.queryByRole("img", { name: "画像20" })).toBeNull();
	const firstObservation = intersect;
	act(() => {
		firstObservation(
			[{ isIntersecting: true } as IntersectionObserverEntry],
			{} as IntersectionObserver,
		);
		firstObservation(
			[{ isIntersecting: true } as IntersectionObserverEntry],
			{} as IntersectionObserver,
		);
	});
	expect(screen.getAllByRole("img")).toHaveLength(40);
	expect(disconnect).toHaveBeenCalled();
	act(() =>
		intersect(
			[{ isIntersecting: true } as IntersectionObserverEntry],
			{} as IntersectionObserver,
		),
	);
	expect(screen.getAllByRole("img")).toHaveLength(45);
	expect(screen.queryByRole("button", { name: "画像をさらに表示" })).toBeNull();
});

it("allows loading the remaining images without an intersection observer", () => {
	vi.stubGlobal("IntersectionObserver", undefined);
	const images = Array.from({ length: 21 }, (_, index) => ({
		id: String(index),
		title: `画像${index}`,
		thumbnailUrl: `/image/${index}`,
	}));
	render(<ImageGrid images={images} onSelect={() => {}} />);
	expect(screen.getAllByRole("img")).toHaveLength(20);
	fireEvent.click(screen.getByRole("button", { name: "画像をさらに表示" }));
	expect(screen.getAllByRole("img")).toHaveLength(21);
	expect(screen.queryByRole("button", { name: "画像をさらに表示" })).toBeNull();
});

it("shows selection circles only in selection mode and keeps the selected state accessible", () => {
	const images = [{ id: "a", title: "森", thumbnailUrl: "/forest" }];
	const onSelect = vi.fn();
	const view = render(
		<ImageGrid images={images} mode="select" onSelect={onSelect} />,
	);
	const button = screen.getByRole("button", { name: "森を選ぶ" });
	expect(button).toHaveAttribute("aria-pressed", "false");
	expect(view.container.querySelector(".image-grid-check")).toHaveAttribute(
		"data-selected",
		"false",
	);
	fireEvent.click(button);
	expect(onSelect).toHaveBeenCalledWith("a");
	view.rerender(
		<ImageGrid
			images={images}
			mode="select"
			selectedId="a"
			onSelect={onSelect}
		/>,
	);
	expect(button).toHaveAttribute("aria-pressed", "true");
	expect(view.container.querySelector(".image-grid-check")).toHaveTextContent(
		"✓",
	);
	view.rerender(
		<ImageGrid
			images={images}
			mode="view"
			selectedId="a"
			onSelect={onSelect}
		/>,
	);
	expect(view.container.querySelector(".image-grid-check")).toBeNull();
	expect(button).not.toHaveAttribute("aria-pressed");
});
