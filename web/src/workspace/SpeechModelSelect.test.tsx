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
		/>,
	);
	for (const control of screen.getAllByRole("combobox"))
		expect(control.hasAttribute("disabled")).toBe(true);
});
