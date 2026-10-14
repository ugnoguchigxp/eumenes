import { ChatImageInput, ChatImagePreviews } from "./ChatImageInput";
import { useStore } from "zustand";
import type { AudioStore } from "../domains/audio";
import { Button, Textarea } from "../design-system";
import { describeError } from "../errorMessages";
import type { WorkspaceState } from "./useWorkspace";

function MicLevelMeter({ store }: { store: AudioStore }) {
	const level = useStore(store, (state) => state.level);
	return (
		<meter
			className="level"
			aria-label="マイク音量"
			min={0}
			max={100}
			value={Math.min(100, level * 800)}
		/>
	);
}

export function ConversationComposer({
	state,
	store,
}: {
	state: WorkspaceState;
	store: AudioStore;
}) {
	const {
		voice,
		phase,
		activeRun,
		send,
		replay,
		mute,
		draft,
		automaticInput,
		submit,
		editInput,
		latestRun,
		audioError,
	} = state;
	const route = [
		{
			id: "microphone",
			label: "マイク",
			active: voice.active && phase === "listening",
		},
		{ id: "asr", label: "音声認識", active: !!voice.turn && !voice.turn.text },
		{ id: "llm", label: "回答", active: !!activeRun },
		{ id: "speech", label: "音声再生", active: phase === "playing" },
	];
	return (
		<div className="chat-bottom">
			<div className="route-track" aria-label="回答の経路">
				{route.map((node, index) => (
					<div className="route-part" key={node.id}>
						{index > 0 && (
							<span className="route-arrow" aria-hidden="true">
								→
							</span>
						)}
						<span className={`route-node${node.active ? " active" : ""}`}>
							<i aria-hidden="true" />
							{node.label}
						</span>
					</div>
				))}
			</div>
			<form className="chat-composer" onSubmit={send}>
				<ChatImagePreviews state={state} />
				<Textarea
					aria-label="メッセージ"
					value={draft}
					onChange={(event) => editInput(event.target.value)}
					onKeyDown={(event) => {
						if ((event.metaKey || event.ctrlKey) && event.key === "Enter")
							event.currentTarget.form?.requestSubmit();
					}}
					placeholder="メッセージを入力、または話しかけてください"
					maxLength={8000}
					rows={4}
				/>
				<div className="composer-actions">
					<ChatImageInput state={state} />
					<div className="voice-controls">
						<Button
							type="button"
							variant={voice.active ? "destructive" : "secondary"}
							onClick={() =>
								void (voice.active
									? voice.pause()
									: (replay.stop(), voice.start()))
							}
							disabled={!voice.active && phase !== "idle"}
							aria-label={voice.active ? "マイクを停止" : "音声を開始"}
						>
							{voice.active ? "マイクを停止" : "音声を開始"}
						</Button>
						<Button
							type="button"
							variant={mute.muted ? "destructive" : "secondary"}
							size="icon"
							onClick={() => void mute.toggle()}
							disabled={!mute.ready || mute.busy}
							aria-pressed={mute.muted}
							aria-label={mute.muted ? "ミュートを解除" : "ミュート"}
							title={
								mute.error ??
								(mute.muted
									? "読み上げをオフにしています"
									: "読み上げをオフにする")
							}
						>
							<svg
								width="20"
								height="20"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="1.8"
								strokeLinecap="round"
								strokeLinejoin="round"
								aria-hidden="true"
							>
								<path d="M11 5 6 9H3v6h3l5 4z" />
								{mute.muted ? (
									<path d="m16 9 5 6M21 9l-5 6" />
								) : (
									<path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />
								)}
							</svg>
						</Button>
						<MicLevelMeter store={store} />
					</div>
					<Button
						type="submit"
						disabled={
							(!draft.trim() && !state.attachments.items.length) ||
							(automaticInput && !state.attachments.items.length) ||
							submit.isPending ||
							state.attachments.busy
						}
						aria-label="送信"
					>
						送信
					</Button>
				</div>
			</form>
			{(submit.isError || voice.error || audioError) && (
				<p className="chat-error" role="alert">
					{submit.isError
						? `送信できませんでした: ${describeError(submit.error)}`
						: voice.error || (audioError ? describeError(audioError) : null)}
				</p>
			)}
			{latestRun?.status === "failed" && (
				<p className="chat-error" role="alert">
					回答を取得できませんでした:{" "}
					{latestRun.error
						? describeError(new Error(latestRun.error))
						: "応答に失敗しました"}
				</p>
			)}
		</div>
	);
}
