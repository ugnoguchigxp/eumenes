import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ApiConnectionError } from "../../../client/transport";
import type { VoiceDialogueClient } from "../../../client/voice-dialogue";
import { createAudioStore, type CreateAudio } from "../domains/audio";
import { useVoiceDialogue } from "../domains/voice-dialogue";
import { ConversationFailures } from "./ConversationFailures";
import type { WorkspaceState } from "./useWorkspace";

afterEach(cleanup);

function renderPlaybackFailure(failingIndex: number) {
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 } },
	});
	const store = createAudioStore();
	const failure = Promise.withResolvers<never>();
	let segment!: (wav: Uint8Array) => void;
	let sessionId = "";
	let restarted = false;
	const ended: (() => void)[] = [];
	const stopPlayback = vi.fn();
	const createAudio: CreateAudio = (_store, _speech, capture) => {
		segment = capture;
		return {
			start: async () => {},
			stop: async () => {},
			stopPlayback,
			play: async (_bytes, onEnded) => {
				ended.push(onEnded);
			},
		};
	};
	const voiceAudio = vi.fn(async (_id: string, index: number) =>
		index === failingIndex ? failure.promise : new Uint8Array([index]),
	);
	const voicePlayed = vi.fn(async () => ({}));
	const voiceCancel = vi.fn(async () => ({}));
	const voiceTurn = async (utteranceId: string) => ({
		utteranceId,
		sessionId,
		generation: 1,
		sequence: 1,
		runId: "run",
		status: restarted ? "interrupted" : "responding",
		text: "依頼",
		error: restarted ? "backend_restarted" : null,
		revision: restarted ? 2 : 1,
		audioGeneration: restarted ? undefined : 1,
		audioChunks: restarted
			? []
			: [
					{ index: 0, text: "最初の句。" },
					{ index: 1, text: "次の句。" },
				],
	});
	const client = {
		identity: "voice-failure-screen",
		voiceStart: async (id: string) => {
			sessionId = id;
		},
		voiceStop: async () => {},
		voiceSend: async (
			_session: string,
			_generation: number,
			_sequence: number,
			id: string,
		) => voiceTurn(id),
		watchVoiceInput: async () => {},
		voiceTurn,
		voiceAudio,
		voicePlayed,
		voiceCancel,
	} as unknown as VoiceDialogueClient;
	function Harness() {
		const voice = useVoiceDialogue(client, store, createAudio);
		const state = {
			conversation: {},
			runs: {},
			settings: {},
			submit: {},
			voice,
			followLatestIfPinned: () => {},
		} as WorkspaceState;
		return (
			<>
				<button onClick={() => void voice.start()}>音声開始</button>
				<button onClick={() => void voice.stop()}>音声停止</button>
				<ConversationFailures state={state} />
			</>
		);
	}
	const app = render(
		<QueryClientProvider client={cache}>
			<Harness />
		</QueryClientProvider>,
	);
	return {
		voiceAudio,
		voicePlayed,
		voiceCancel,
		stopPlayback,
		async begin() {
			await act(async () =>
				fireEvent.click(screen.getByRole("button", { name: "音声開始" })),
			);
			act(() => segment(new Uint8Array(44)));
			await waitFor(() => expect(voiceAudio).toHaveBeenCalledTimes(2));
		},
		async finishFirst() {
			await waitFor(() => expect(ended).toHaveLength(1));
			await act(async () => ended[0]!());
			expect(voicePlayed).toHaveBeenCalledTimes(1);
		},
		async fail() {
			await act(async () => failure.reject(new ApiConnectionError()));
		},
		async receiveRestart() {
			restarted = true;
			await act(async () => cache.invalidateQueries());
		},
		close() {
			app.unmount();
			cache.clear();
		},
	};
}

test.each([
	{
		failingIndex: 1,
		detail: "最後に再生完了を確認した句は「最初の句。」です。",
	},
	{ failingIndex: 0, detail: "どこまで再生できたか確認できませんでした。" },
])(
	"the chat shows the known playback position after chunk $failingIndex exhausts its retry",
	async ({ failingIndex, detail }) => {
		const f = renderPlaybackFailure(failingIndex);
		try {
			await f.begin();
			if (failingIndex === 1) await f.finishFirst();
			await f.fail();
			const notice = await screen.findByRole("article", { name: "会話エラー" });
			expect(f.voiceAudio).toHaveBeenCalledTimes(3);
			expect(f.voiceCancel).toHaveBeenCalledTimes(1);
			expect(within(notice).getByText(detail)).toBeTruthy();
			fireEvent.click(
				within(notice).getByRole("button", { name: "エラーの詳細" }),
			);
			const report = await screen.findByLabelText("エラーレポート本文");
			expect(report.textContent).not.toContain("最初の句。");
		} finally {
			f.close();
		}
	},
);

test.each([
	{
		failingIndex: 1,
		detail: "最後に再生完了を確認した句は「最初の句。」です。",
	},
	{ failingIndex: 0, detail: "どこまで再生できたか確認できませんでした。" },
])(
	"the chat identifies an interrupted reply after restart with its available playback position ($failingIndex)",
	async ({ failingIndex, detail }) => {
		const f = renderPlaybackFailure(failingIndex);
		try {
			await f.begin();
			if (failingIndex === 1) await f.finishFirst();
			await f.receiveRestart();
			await waitFor(() => expect(f.stopPlayback).toHaveBeenCalled());
			const notice = screen.getByRole("article", { name: "会話エラー" });
			expect(within(notice).getByText("読み上げが中断しました")).toBeTruthy();
			expect(
				within(notice).getByText("サーバーが再起動しました。"),
			).toBeTruthy();
			expect(within(notice).getByText(detail)).toBeTruthy();
			expect(f.voiceCancel).not.toHaveBeenCalled();
		} finally {
			f.close();
		}
	},
);

test("stopping during the retry delay does not add a playback failure to the chat", async () => {
	const f = renderPlaybackFailure(1);
	try {
		await f.begin();
		await f.finishFirst();
		await f.fail();
		await act(async () =>
			fireEvent.click(screen.getByRole("button", { name: "音声停止" })),
		);
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 350));
		});
		await f.receiveRestart();
		expect(screen.queryByRole("article", { name: "会話エラー" })).toBeNull();
		expect(f.voiceAudio).toHaveBeenCalledTimes(2);
		expect(f.voiceCancel).not.toHaveBeenCalled();
	} finally {
		f.close();
	}
});
