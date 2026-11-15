import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { expect, test, vi } from "vitest";
import { useVoiceDraft } from "./useVoiceDraft";
import type { useVoiceDialogue } from "../domains/voice-dialogue";
import type { ChatDraft } from "./chat-send";

const heard = {
	active: true,
	recognitionId: "input",
	transcription: { id: "input", text: "認識された入力" },
	inputStatus: "ready",
	inputHold: null,
	turn: undefined,
	takeInputOwnership: vi.fn(),
} as unknown as ReturnType<typeof useVoiceDialogue>;
const watchRun = vi.fn();
function setup() {
	return renderHook(
		({ voice }) => {
			const [input, setInput] = useState<ChatDraft>({
				text: "",
				dictated: false,
			});
			return { input, ...useVoiceDraft(input, setInput, voice, watchRun) };
		},
		{ initialProps: { voice: heard } },
	);
}
test("cancellation and failed input remove only dictated content", () => {
	for (const manual of [false, true]) {
		const h = setup();
		expect(h.result.current.input.text).toBe("認識された入力");
		if (manual) act(() => h.result.current.editInput("手修正した入力"));
		h.rerender({
			voice: {
				...heard,
				recognitionId: null,
				transcription: null,
				inputStatus: "idle",
				active: false,
			},
		});
		expect(h.result.current.input.text).toBe(manual ? "手修正した入力" : "");
		h.unmount();
	}
});
test("late results cannot overwrite manual edits and drafts can be sent explicitly", () => {
	const h = setup();
	act(() => h.result.current.editInput("確認した内容"));
	h.rerender({
		voice: {
			...heard,
			inputHold: "edited",
			transcription: { id: "input", text: "遅れて届いた別の内容" },
		},
	});
	expect(h.result.current.input.text).toBe("確認した内容");
	expect(h.result.current.automaticInput).toBe(false);
	h.unmount();
	const draft = setup();
	draft.rerender({ voice: { ...heard, inputHold: "delayed" } });
	expect(draft.result.current.input.text).toBe("認識された入力");
	expect(draft.result.current.automaticInput).toBe(false);
	draft.unmount();
});
test("accepted automatic input leaves the composer without deleting subsequent manual text", () => {
	const h = setup();
	h.rerender({ voice: { ...heard, inputStatus: "sent" } });
	expect(h.result.current.input.text).toBe("");
	act(() => h.result.current.editInput("次の文章"));
	h.rerender({ voice: { ...heard, inputStatus: "sent" } });
	expect(h.result.current.input.text).toBe("次の文章");
	h.unmount();
});
