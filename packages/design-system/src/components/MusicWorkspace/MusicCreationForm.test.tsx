import {
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MusicCreationForm } from "./MusicCreationForm";
import { defaultMusicCreationOptions } from "./music-creation-options";
afterEach(cleanup);
const prompt = () =>
	screen.getByRole("textbox", {
		name: "音楽作成プロンプト",
	}) as HTMLTextAreaElement;
it("selects multiple genres including orchestra, filters the catalogue and removes only the chosen genre", () => {
	const generate = vi.fn();
	render(<MusicCreationForm onGenerate={generate} />);
	expect(screen.getAllByRole("checkbox").length).toBeGreaterThan(60);
	fireEvent.click(
		screen.getByRole("checkbox", { name: "オーケストラ" }),
	);
	fireEvent.click(
		screen.getByRole("checkbox", { name: "Ambient" }),
	);
	expect(prompt().value).toContain("オーケストラ、Ambient");
	fireEvent.change(screen.getByRole("textbox", { name: "ジャンルを探す" }), {
		target: { value: "orch-not-found" },
	});
	expect(
		screen.getByText("該当するジャンルはありません。"),
	).toBeInTheDocument();
	fireEvent.click(screen.getByRole("button", { name: "Ambientを解除" }));
	expect(prompt().value).toContain("オーケストラ");
	expect(prompt().value).not.toContain("Ambient");
	fireEvent.click(screen.getByRole("button", { name: "楽曲を生成" }));
	expect(generate).toHaveBeenCalledWith(prompt().value);
});
it("preserves a hand-written prompt, requires a decision on changed choices and allows restoring overwritten text", () => {
	render(<MusicCreationForm onGenerate={vi.fn()} />);
	fireEvent.change(prompt(), { target: { value: "手書きの曲の希望を残す" } });
	fireEvent.click(
		screen.getByRole("checkbox", { name: "ロック" }),
	);
	expect(prompt().value).toBe("手書きの曲の希望を残す");
	expect(screen.getByRole("button", { name: "楽曲を生成" })).toBeDisabled();
	fireEvent.click(screen.getByRole("button", { name: "編集内容を使う" }));
	expect(prompt().value).toBe("手書きの曲の希望を残す");
	fireEvent.click(
		screen.getByRole("checkbox", { name: "ポップ" }),
	);
	fireEvent.click(screen.getByRole("button", { name: "選択内容を反映" }));
	expect(prompt().value).toContain("ロック、ポップ");
	fireEvent.click(screen.getByRole("button", { name: "編集内容に戻す" }));
	expect(prompt().value).toBe("手書きの曲の希望を残す");
});
it("reflects vocal characteristics and exact lyric line breaks, and removes them when vocals are turned off", () => {
	render(<MusicCreationForm onGenerate={vi.fn()} />);
	fireEvent.click(screen.getByRole("checkbox", { name: "歌声を入れる" }));
	fireEvent.change(
		screen.getByRole("combobox", { name: "ボーカル" }),
		{ target: { value: "女性ボーカル" } },
	);
	fireEvent.change(screen.getByRole("combobox", { name: "声の高さ" }), {
		target: { value: "高め" },
	});
	fireEvent.click(
		within(screen.getByRole("group", { name: "声質" })).getByRole("checkbox", {
			name: "柔らかい",
		}),
	);
	const lyrics = "[Verse]\n朝の光が窓を照らす\n新しい一日が始まる";
	fireEvent.change(screen.getByRole("textbox", { name: "歌詞（任意）" }), {
		target: { value: lyrics },
	});
	expect(prompt().value).toContain("歌声：あり");
	expect(prompt().value).toContain("女性ボーカル");
	expect(prompt().value).toContain("声質：柔らかい");
	expect(prompt().value).toContain(lyrics);
	fireEvent.click(screen.getByRole("checkbox", { name: "歌声を入れる" }));
	expect(prompt().value).toContain("歌声：なし");
	expect(prompt().value).not.toContain(lyrics);
	expect(
		screen.queryByRole("combobox", { name: "ボーカル" }),
	).not.toBeInTheDocument();
});
it("does not submit a blank or busy draft", () => {
	const generate = vi.fn();
	const result = render(<MusicCreationForm busy onGenerate={generate} />);
	expect(screen.getByRole("button", { name: "生成処理中" })).toBeDisabled();
	result.rerender(<MusicCreationForm onGenerate={generate} />);
	fireEvent.change(prompt(), { target: { value: "  " } });
	expect(screen.getByRole("button", { name: "楽曲を生成" })).toBeDisabled();
	fireEvent.submit(prompt().closest("form")!);
	expect(generate).not.toHaveBeenCalled();
});
it("uses registered choices and defaults when a screen supplies them", () => {
	const options = {
		...defaultMusicCreationOptions,
		genreGroups: [{ label: "新しいジャンル", options: ["和風アンビエント"] }],
		tempos: ["ゆっくり", "疾走感"],
		defaults: { ...defaultMusicCreationOptions.defaults, tempo: "ゆっくり" },
	};
	render(<MusicCreationForm options={options} onGenerate={vi.fn()} />);
	expect(prompt().value).toContain("テンポ：ゆっくり");
	expect(screen.getByRole("checkbox", { name: "和風アンビエント" })).toBeVisible();
	expect(screen.queryByRole("checkbox", { name: "オーケストラ" })).toBeNull();
	fireEvent.click(screen.getByRole("checkbox", { name: "和風アンビエント" }));
	expect(prompt().value).toContain("ジャンル：和風アンビエント");
});
