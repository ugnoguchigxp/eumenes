import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { createSettingsBackend, newCache, Screens } from "./settings.fixture";

afterEach(cleanup);

test("display edits preview before saving, review all five fields, keep a conflicted draft, save and discard in the shared draft", async () => {
	const backend = createSettingsBackend();
	render(
		<Screens backend={backend} start="display" cache={newCache(backend)} />,
	);
	await screen.findByLabelText("テーマ");
	expect(
		screen.getByRole("button", { name: "設定の変更をすべて保存" }),
	).toHaveProperty("disabled", true);
	fireEvent.change(screen.getByLabelText("会話の背景"), {
		target: { value: "spatial" },
	});
	fireEvent.change(screen.getByLabelText("テーマ"), {
		target: { value: "dark" },
	});
	fireEvent.click(screen.getByLabelText("読み上げ字幕を表示する"));
	fireEvent.change(screen.getByLabelText("字幕のデザイン"), {
		target: { value: "classic" },
	});
	fireEvent.change(screen.getByLabelText("字幕の大きさ"), {
		target: { value: "xlarge" },
	});
	expect(screen.getByTestId("subtitle").getAttribute("data-style")).toBe(
		"classic",
	);
	expect(screen.getByTestId("subtitle").getAttribute("data-size")).toBe(
		"xlarge",
	);
	expect(backend.saved()).toEqual(backend.original);
	fireEvent.click(screen.getByText("閉じる"));
	fireEvent.click(screen.getByText("開く:display"));
	expect(await screen.findByLabelText("テーマ")).toHaveProperty(
		"value",
		"dark",
	);
	fireEvent.click(screen.getByRole("button", { name: "変更一覧を開く" }));
	for (const label of [
		"会話の背景",
		"テーマ",
		"読み上げ字幕を表示する",
		"字幕のデザイン",
		"字幕の大きさ",
	])
		await screen.findByText("表示 / " + label);
	fireEvent.click(screen.getByText("開く:display"));
	// Someone else saved in between: the apply is a conflict and the draft survives.
	const saved = backend.saved();
	backend.setSaved({ ...saved, revision: saved.revision + 1 });
	fireEvent.click(
		await screen.findByRole("button", { name: "設定の変更をすべて保存" }),
	);
	await screen.findByText(/別の画面で設定が変更されました/);
	expect(screen.getByLabelText("字幕のデザイン")).toHaveProperty(
		"value",
		"classic",
	);
	// The re-read document has the new revision, so the same draft applies.
	await waitFor(() =>
		expect(backend.client.settings.mock.calls.length).toBeGreaterThan(1),
	);
	fireEvent.click(
		screen.getByRole("button", { name: "設定の変更をすべて保存" }),
	);
	await screen.findByText("変更を適用しました");
	expect(backend.saved().general).toMatchObject({
		background: "spatial",
		theme: "dark",
		subtitles: { enabled: true, style: "classic", size: "xlarge" },
	});
	expect(backend.saved().voice).toEqual(backend.original.voice);
	expect(backend.client.larmVoices).not.toHaveBeenCalled();
	fireEvent.change(screen.getByLabelText("テーマ"), {
		target: { value: "light" },
	});
	fireEvent.click(screen.getByRole("button", { name: "変更一覧を開く" }));
	fireEvent.click(
		await screen.findByRole("button", { name: "未適用の設定変更をすべて破棄" }),
	);
	fireEvent.click(screen.getByText("開く:display"));
	await waitFor(() =>
		expect(screen.getByLabelText("テーマ")).toHaveProperty("value", "dark"),
	);
});

test("an optional key is unset by sending an unset change, and the default stays selected", async () => {
	const backend = createSettingsBackend();
	const withBackground = structuredClone(backend.saved());
	withBackground.general.background = "spatial";
	backend.setSaved(withBackground);
	render(
		<Screens
			backend={backend}
			start="display"
			cache={newCache(backend, withBackground)}
		/>,
	);
	await screen.findByLabelText("会話の背景");
	fireEvent.change(screen.getByLabelText("会話の背景"), {
		target: { value: "" },
	});
	fireEvent.click(
		screen.getByRole("button", { name: "設定の変更をすべて保存" }),
	);
	await screen.findByText("変更を適用しました");
	expect(backend.sent[0]!.input).toMatchObject({
		changes: [{ fieldId: "display.background", unset: true }],
	});
	expect(backend.saved().general.background).toBeUndefined();
});

test("choices outside the registration, a foreign value type and a stale event are refused before anything is saved", async () => {
	const backend = createSettingsBackend();
	render(
		<Screens backend={backend} start="display" cache={newCache(backend)} />,
	);
	await screen.findByLabelText("テーマ");
	const theme = screen.getByLabelText("テーマ") as HTMLSelectElement;
	// A select can only offer registered options; forcing another value is refused by the host.
	const option = document.createElement("option");
	option.value = "purple";
	theme.append(option);
	fireEvent.change(theme, { target: { value: "purple" } });
	await waitFor(() =>
		expect(
			screen.getByRole("button", { name: "設定の変更をすべて保存" }),
		).toHaveProperty("disabled", true),
	);
	expect(backend.sent).toHaveLength(0);
});
