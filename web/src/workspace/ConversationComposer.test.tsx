import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { createAudioStore } from "../domains/audio";
import { ConversationComposer } from "./ConversationComposer";
import type { WorkspaceState } from "./useWorkspace";

afterEach(cleanup);

test("preparing is visible and cancellable until microphone frames arrive", () => {
	const store = createAudioStore();
	const pause = vi.fn();
	const state = {
		voice: { active: true, pause },
		phase: "listening",
		attachments: { items: [], busy: false },
		status: {},
		specialist: { addressee: { kind: "normal", label: "会話" } },
		mute: { muted: false, ready: true, busy: false },
		draft: "",
		submit: { isPending: false },
	} as unknown as WorkspaceState;
	store.setState({ inputPhase: "starting" });
	const view = render(<ConversationComposer state={state} store={store} />);
	expect(
		screen.getByText("音声入力を準備中です。少しお待ちください。"),
	).toBeTruthy();
	expect(screen.queryByText("話しかけてください")).toBeNull();
	expect(screen.getByText("マイク").classList.contains("active")).toBe(false);
	fireEvent.click(screen.getByRole("button", { name: "マイクを停止" }));
	expect(pause).toHaveBeenCalledOnce();
	act(() => store.setState({ inputPhase: "ready" }));
	expect(
		screen.queryByText("音声入力を準備中です。少しお待ちください。"),
	).toBeNull();
	expect(screen.getByText("話しかけてください")).toBeTruthy();
	expect(screen.getByText("マイク").classList.contains("active")).toBe(true);
	view.rerender(
		<ConversationComposer
			state={{ ...state, voice: { ...state.voice, active: false } }}
			store={store}
		/>,
	);
	expect(screen.queryByText("話しかけてください")).toBeNull();
	expect(screen.getByRole("button", { name: "音声を開始" })).toBeTruthy();
});
