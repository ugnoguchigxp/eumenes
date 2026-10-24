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
		edit: { editing: null, target: null },
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

test("the edit state names itself, sends as an update, stops with Esc and shows why the host refused", () => {
	const store = createAudioStore();
	const stop = vi.fn();
	const start = vi.fn();
	const send = vi.fn((event: Event) => event.preventDefault());
	const base = {
		voice: { active: false },
		phase: "idle",
		attachments: { items: [], busy: false },
		status: {},
		specialist: { addressee: { kind: "normal", label: "会話" } },
		mute: { muted: false, ready: true, busy: false },
		submit: { isPending: false },
		editInput: vi.fn(),
		send,
	};
	const idle = {
		...base,
		draft: "",
		edit: {
			editing: null,
			target: { message: { id: "m" } },
			start,
			stop,
		},
	} as unknown as WorkspaceState;
	const view = render(<ConversationComposer state={idle} store={store} />);
	// An empty composer's up arrow edits the latest utterance.
	fireEvent.keyDown(screen.getByLabelText("メッセージ"), { key: "ArrowUp" });
	expect(start).toHaveBeenCalledOnce();
	const editing = {
		...base,
		draft: "直した本文",
		edit: {
			editing: { id: "m", text: "元の本文", attachments: [{ id: "a" }] },
			target: null,
			pending: false,
			error: "実行が始まっていたため編集できませんでした。",
			start,
			stop,
		},
	} as unknown as WorkspaceState;
	view.rerender(<ConversationComposer state={editing} store={store} />);
	expect(screen.getByText(/直前の発言を編集中/).textContent).toContain(
		"添付はそのまま送ります",
	);
	expect(screen.getByRole("alert").textContent).toBe(
		"実行が始まっていたため編集できませんでした。",
	);
	expect(screen.queryByRole("button", { name: "送信" })).toBeNull();
	fireEvent.click(screen.getByRole("button", { name: "更新して送信" }));
	expect(send).toHaveBeenCalledOnce();
	fireEvent.keyDown(screen.getByLabelText("メッセージ"), { key: "Escape" });
	fireEvent.click(screen.getByRole("button", { name: "やめる" }));
	expect(stop).toHaveBeenCalledTimes(2);
});
