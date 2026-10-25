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
		stewardActivity: {},
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
		stewardActivity: {},
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

test("the memory keeper is lit while a step runs and offers the error report from a small icon while one fails", async () => {
	const store = createAudioStore();
	const report = vi.fn(async () => ({
		text: "# Eumenes エラーレポート（メモリー整理）",
	}));
	const base = {
		voice: { active: false },
		phase: "idle",
		attachments: { items: [], busy: false },
		status: {},
		specialist: { addressee: { kind: "normal", label: "会話" } },
		mute: { muted: false, ready: true, busy: false },
		draft: "",
		submit: { isPending: false },
		edit: { editing: null, target: null },
		stewardErrorReport: report,
	};
	const idle = {
		...base,
		stewardActivity: { data: { running: false, slots: [], errors: [] } },
	} as unknown as WorkspaceState;
	const view = render(<ConversationComposer state={idle} store={store} />);
	const node = () => screen.getByText("メモリー整理");
	expect(node().classList.contains("active")).toBe(false);
	expect(node().classList.contains("failed")).toBe(false);
	expect(
		screen.queryByRole("button", { name: "メモリー整理のエラーの詳細" }),
	).toBeNull();
	const failing = {
		...base,
		stewardActivity: {
			data: {
				running: true,
				slots: ["reflect"],
				errors: [
					{
						slot: "world",
						step: "curate-world",
						code: "cloud_agent_billing_error",
						at: "2026-10-25T04:51:33.982Z",
					},
				],
			},
		},
	} as unknown as WorkspaceState;
	view.rerender(<ConversationComposer state={failing} store={store} />);
	expect(node().classList.contains("active")).toBe(true);
	expect(node().classList.contains("failed")).toBe(true);
	expect(node().getAttribute("title")).toBe(
		"記憶の反映／失敗: 世界の記録（cloud_agent_billing_error）",
	);
	expect(report).not.toHaveBeenCalled();
	fireEvent.click(
		screen.getByRole("button", { name: "メモリー整理のエラーの詳細" }),
	);
	const text = await screen.findByLabelText("エラーレポート本文");
	expect(text.textContent).toBe("# Eumenes エラーレポート（メモリー整理）");
	expect(screen.getByText("メモリー整理に失敗しています")).toBeTruthy();
	expect(report).toHaveBeenCalledWith(expect.any(AbortSignal));
	// The failure clears while its report is read: the dialog stays, the icon goes.
	view.rerender(<ConversationComposer state={idle} store={store} />);
	expect(screen.getByLabelText("エラーレポート本文")).toBeTruthy();
	expect(node().classList.contains("failed")).toBe(false);
	fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
	await vi.waitFor(() =>
		expect(screen.queryByLabelText("エラーレポート本文")).toBeNull(),
	);
	expect(
		screen.queryByRole("button", { name: "メモリー整理のエラーの詳細" }),
	).toBeNull();
});
