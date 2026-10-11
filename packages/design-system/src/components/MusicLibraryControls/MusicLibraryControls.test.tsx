import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, test, expect, vi } from "vitest";
import { MusicLibraryControls } from "./MusicLibraryControls";
afterEach(cleanup);
test("dynamic multiple tags, ordering, favorites and query are submitted together", () => {
	const onSearch = vi.fn();
	render(
		<MusicLibraryControls
			filter={{ q: "", tags: [], sort: "createdAt", order: "desc" }}
			tags={[
				{ tag: "明るい", count: 5 },
				{ tag: "ピアノ", count: 3 },
			]}
			onSearch={onSearch}
			onMore={() => {}}
			onRefresh={() => {}}
		/>,
	);
	fireEvent.change(screen.getByLabelText("検索"), { target: { value: "春" } });
	fireEvent.click(screen.getByLabelText("明るい (5)"));
	fireEvent.click(screen.getByLabelText("ピアノ (3)"));
	fireEvent.change(screen.getByLabelText("並び順"), {
		target: { value: "relevance" },
	});
	fireEvent.change(screen.getByLabelText("表示"), {
		target: { value: "favorites" },
	});
	fireEvent.click(screen.getByRole("button", { name: "検索する" }));
	expect(onSearch).toHaveBeenCalledWith({
		q: "春",
		tags: ["明るい", "ピアノ"],
		favorite: true,
		sort: "relevance",
		order: "desc",
	});
});
test("loading, failure and retry stay visible", () => {
	const retry = vi.fn();
	render(
		<MusicLibraryControls
			filter={{ q: "", tags: [], sort: "createdAt", order: "desc" }}
			tags={[]}
			error="認証エラー"
			onSearch={() => {}}
			onMore={() => {}}
			onRefresh={retry}
		/>,
	);
	expect(screen.getByRole("alert")).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "再試行" }));
	expect(retry).toHaveBeenCalledOnce();
});
