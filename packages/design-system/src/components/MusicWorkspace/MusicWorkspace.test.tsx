import {
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MusicWorkspace } from "./MusicWorkspace";
import type { PlaylistTrack } from "../MusicPlayer";

const tracks = [
	{
		id: "a",
		title: "曲A",
		durationSeconds: 30,
		subtitle: "静かなピアノ",
		tags: ["ピアノ"],
		favorite: false,
	},
	{ id: "b", title: "曲B", durationSeconds: 45, lyrics: "歌詞の全文" },
];
beforeEach(() => {
	vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});
function setup() {
	const favorite = vi.fn(),
		select = vi.fn();
	const props = {
		tracks,
		track: { ...tracks[0]!, src: "blob:audio" },
		currentTrackId: "a",
		onSelect: select,
		onFavorite: favorite,
	};
	const result = render(<MusicWorkspace {...props} />);
	return { ...result, props, favorite, select };
}
it("switches left display without replacing the shared audio, and reports missing artwork", () => {
	const r = setup();
	const audio = r.container.querySelector("audio");
	fireEvent.click(screen.getByRole("button", { name: "楽曲イメージ" }));
	expect(
		screen.getByText("この楽曲のイメージは未登録です。"),
	).toBeInTheDocument();
	expect(r.container.querySelector("audio")).toBe(audio);
	fireEvent.click(screen.getByRole("button", { name: "Visualizer" }));
	expect(screen.getByLabelText("Visualizerの表示")).toBeVisible();
	expect(r.container.querySelector("audio")).toBe(audio);
});
it("shows details for another track without selecting it and hides metadata from the list", () => {
	const r = setup();
	expect(screen.queryByText("静かなピアノ")).not.toBeInTheDocument();
	fireEvent.click(screen.getByRole("button", { name: "曲Bの詳細" }));
	const dialog = screen.getByRole("dialog");
	expect(within(dialog).getByText("歌詞の全文")).toBeInTheDocument();
	expect(within(dialog).getByText("00:45")).toBeInTheDocument();
	expect(r.select).not.toHaveBeenCalled();
	expect(r.container.querySelectorAll("audio")).toHaveLength(1);
});
it("emits favorite intent from the star before the title and reflects authoritative props", () => {
	const r = setup();
	const star = screen.getByRole("button", { name: "曲Aをお気に入り登録" });
	expect(star).toHaveAttribute("aria-pressed", "false");
	expect(star.nextElementSibling?.textContent).toBe("曲A");
	fireEvent.click(star);
	expect(r.favorite).toHaveBeenCalledWith("a", true);
	expect(star).toHaveAttribute("aria-pressed", "false");
	r.rerender(
		<MusicWorkspace
			{...r.props}
			tracks={[{ ...tracks[0]!, favorite: true }, tracks[1]!]}
		/>,
	);
	expect(
		screen.getByRole("button", { name: "曲Aをお気に入りから解除" }),
	).toHaveAttribute("aria-pressed", "true");
});
it("shows supplied artwork and paginates many tracks without adding another player", () => {
	const r = setup();
	r.rerender(
		<MusicWorkspace
			{...r.props}
			tracks={Array.from({ length: 12 }, (_, i) => ({
				...tracks[0]!,
				id: i === 0 ? "a" : `track-${i}`,
				title: `曲${i}`,
				artworkUrl: "https://example.com/art.png",
			}))}
		/>,
	);
	fireEvent.click(screen.getByRole("button", { name: "楽曲イメージ" }));
	expect(
		screen.getByRole("img", { name: "曲0の楽曲イメージ" }),
	).toHaveAttribute("src", "https://example.com/art.png");
	fireEvent.click(screen.getByRole("button", { name: "次へ" }));
	expect(
		screen.getByRole("button", { name: /曲11.*0:30/ }),
	).toBeInTheDocument();
	expect(
		screen.queryByRole("button", { name: /曲1 0:30/ }),
	).not.toBeInTheDocument();
	expect(r.container.querySelectorAll("audio")).toHaveLength(1);
});
it("reuses the player for creation and history, and reuses a saved prompt without interpreting it", () => {
	const r = setup();
	r.rerender(
		<MusicWorkspace
			{...r.props}
			tracks={[
				{ ...tracks[0]!, prompt: "保存したオーケストラの希望" },
				tracks[1]!,
			]}
			creation={{ onGenerate: vi.fn() }}
		/>,
	);
	const audio = r.container.querySelector("audio");
	expect(screen.getByRole("button", { name: "Visualizer" })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	expect(
		screen.getByRole("img", { name: "再生音声のVisualizer" }),
	).toBeVisible();
	fireEvent.click(screen.getByRole("button", { name: "楽曲イメージ" }));
	expect(
		screen.queryByRole("button", { name: "イメージを作成" }),
	).not.toBeInTheDocument();
	fireEvent.click(screen.getByRole("button", { name: "生成履歴" }));
	fireEvent.click(
		screen.getByRole("button", { name: "この曲のプロンプトを使う" }),
	);
	expect(
		screen.getByRole("textbox", { name: "音楽作成プロンプト" }),
	).toHaveValue("保存したオーケストラの希望");
	expect(r.container.querySelector("audio")).toBe(audio);
	fireEvent.click(screen.getByRole("button", { name: "Visualizer" }));
	expect(r.container.querySelector("audio")).toBe(audio);
});
it("requests artwork from the track's prompt, shows progress, and offers regeneration with the title", () => {
	const onArtwork = vi.fn();
	const r = setup();
	const base = { ...tracks[0]!, prompt: "雨の夜のピアノ" };
	const show = (track: PlaylistTrack) =>
		r.rerender(
			<MusicWorkspace
				{...r.props}
				tracks={[track, tracks[1]!]}
				onArtwork={onArtwork}
			/>,
		);
	show(base);
	fireEvent.click(screen.getByRole("button", { name: "楽曲イメージ" }));
	fireEvent.click(screen.getByRole("button", { name: "イメージを作成" }));
	expect(onArtwork).toHaveBeenCalledWith(base.id);
	r.rerender(
		<MusicWorkspace
			{...r.props}
			busy
			tracks={[base, tracks[1]!]}
			onArtwork={onArtwork}
		/>,
	);
	expect(screen.getByText("楽曲イメージを生成しています。")).toBeVisible();
	expect(screen.getByRole("button", { name: "生成中" })).toBeDisabled();
	show({ ...base, artworkStatus: "generating" });
	expect(screen.getByText("楽曲イメージを生成しています。")).toBeVisible();
	expect(screen.getByRole("button", { name: "生成中" })).toBeDisabled();
	show({ ...base, artworkStatus: "failed" });
	expect(screen.getByRole("alert")).toHaveTextContent(
		"楽曲イメージを作成できませんでした。",
	);
	show({
		...base,
		artworkStatus: "completed",
		artworkUrl: "blob:artwork",
	});
	expect(
		screen.getByRole("img", { name: `${base.title}の楽曲イメージ` }),
	).toHaveAttribute("src", "blob:artwork");
	expect(
		screen.getByRole("figure").querySelector("figcaption"),
	).toHaveTextContent(base.title);
	fireEvent.click(screen.getByRole("button", { name: "作り直す" }));
	expect(onArtwork).toHaveBeenCalledTimes(2);
	show({ ...base, prompt: undefined });
	expect(screen.getByRole("button", { name: "イメージを作成" })).toBeDisabled();
});
