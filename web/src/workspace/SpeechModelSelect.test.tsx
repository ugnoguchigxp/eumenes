import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { SpeechModelSelect } from "./SpeechModelSelect";

beforeAll(() => {
	Element.prototype.hasPointerCapture = () => false;
	Element.prototype.setPointerCapture = () => {};
	Element.prototype.releasePointerCapture = () => {};
	Element.prototype.scrollIntoView = () => {};
});
afterEach(cleanup);

const model = {
	selected: "larm",
	options: [
		{ id: "larm", label: "LARM" },
		{ id: "cloud", label: "登録音声モデル" },
	],
};

test("both labelled selects dispatch the purpose and chosen resource", async () => {
	const select = vi.fn();
	render(
		<SpeechModelSelect
			models={{
				ready: true,
				busy: false,
				error: null,
				asr: model,
				tts: model,
				select,
			}}
			disabled={false}
			openAsrSettings={vi.fn()}
		/>,
	);
	for (const purpose of ["ASR", "TTS"]) {
		fireEvent.keyDown(
			screen.getByRole("combobox", { name: `${purpose}モデル` }),
			{ key: "ArrowDown" },
		);
		fireEvent.click(
			await screen.findByRole("option", { name: "登録音声モデル" }),
		);
		expect(select).toHaveBeenLastCalledWith(purpose.toLowerCase(), "cloud");
	}
});

test("controls are locked while voice or saving is active", () => {
	render(
		<SpeechModelSelect
			models={{
				ready: true,
				busy: false,
				error: null,
				asr: model,
				tts: model,
				select: vi.fn(),
			}}
			disabled
			openAsrSettings={vi.fn()}
		/>,
	);
	for (const control of screen.getAllByRole("combobox"))
		expect(control.hasAttribute("disabled")).toBe(true);
});

test("opens ASR setup from the chat without selecting or saving a model", async () => {
	const select = vi.fn();
	const openAsrSettings = vi.fn();
	render(
		<SpeechModelSelect
			models={{
				ready: true,
				busy: false,
				error: null,
				asr: model,
				tts: model,
				select,
			}}
			disabled={false}
			openAsrSettings={openAsrSettings}
		/>,
	);
	const asr = screen.getByRole("combobox", { name: "ASRモデル" });
	fireEvent.keyDown(asr, { key: "ArrowDown" });
	fireEvent.click(
		await screen.findByRole("option", { name: "ASRモデルを登録…" }),
	);
	expect(openAsrSettings).toHaveBeenCalledOnce();
	expect(select).not.toHaveBeenCalled();
	expect(asr.textContent).toContain("LARM");
});
