import { useRef } from "react";
import { ChatImageInput, ChatImagePreviews } from "./ChatImageInput";
import { useStore } from "zustand";
import type { AudioStore } from "../domains/audio";
import { Button, Spinner, Textarea } from "../design-system";
import { ApiError } from "../../../client/transport";
import { describeError } from "../errorMessages";
import type { StewardActivity } from "../../../api/domains/steward/contracts";
import { ErrorReportButton } from "./ErrorReportDialog";
import type { WorkspaceState } from "./useWorkspace";

const STEWARD_SLOT_LABELS: Record<StewardActivity["slots"][number], string> = {
	reflect: "記憶の反映",
	world: "世界の記録",
	maintenance: "記憶の整理",
};

/**
 * The background memory keeper beside the answer path: lit while one of its steps runs, a red dot and a small
 * warning icon (the error report) while one of its steps is failing.
 */
function StewardNode({
	activity,
	loadReport,
}: {
	activity: StewardActivity | undefined;
	loadReport: (signal: AbortSignal) => Promise<{ text: string }>;
}) {
	const running = activity?.running ?? false;
	const errors = activity?.errors ?? [];
	// The report stays mounted once a failure was seen, so a dialog being read survives the failure clearing.
	const lastSummary = useRef<string | null>(null);
	if (errors.length)
		lastSummary.current = errors
			.map((e) => `${STEWARD_SLOT_LABELS[e.slot]}: ${e.code}`)
			.join("、");
	const title = [
		running
			? activity!.slots.map((slot) => STEWARD_SLOT_LABELS[slot]).join("・")
			: undefined,
		errors.length
			? `失敗: ${errors.map((e) => `${STEWARD_SLOT_LABELS[e.slot]}（${e.code}）`).join("、")}`
			: undefined,
	]
		.filter(Boolean)
		.join("／");
	return (
		<div className="route-part route-steward">
			<span
				className={`route-node${running ? " active" : ""}${errors.length ? " failed" : ""}`}
				title={title || undefined}
			>
				<i aria-hidden="true" />
				メモリー整理
				{lastSummary.current !== null && (
					<ErrorReportButton
						load={loadReport}
						heading="メモリー整理に失敗しています"
						summary={lastSummary.current}
						trigger="icon"
						label="メモリー整理のエラーの詳細"
						hidden={errors.length === 0}
					/>
				)}
			</span>
		</div>
	);
}

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
		audioError,
		edit,
	} = state;
	const editing = edit.editing;
	const inputPhase = useStore(store, (audio) => audio.inputPhase);
	const starting = voice.active && inputPhase === "starting";
	const route = [
		{
			id: "microphone",
			label: "マイク",
			active: voice.active && !starting && phase === "listening",
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
				<StewardNode
					activity={state.stewardActivity.data}
					loadReport={state.stewardErrorReport}
				/>
			</div>
			<output className="composer-status" aria-live="polite">
				{starting ? (
					<small>
						<Spinner size="xs" aria-hidden="true" />{" "}
						音声入力を準備中です。少しお待ちください。
					</small>
				) : voice.active && inputPhase === "ready" && phase === "listening" ? (
					<small>話しかけてください</small>
				) : null}
			</output>
			{editing && (
				<div className="composer-edit">
					<span>
						直前の発言を編集中
						{editing.attachments?.length ? "（添付はそのまま送ります）" : ""}
					</span>
					<Button type="button" variant="ghost" size="sm" onClick={edit.stop}>
						やめる
					</Button>
					{edit.error && (
						<p className="composer-edit-error" role="alert">
							{edit.error}
						</p>
					)}
				</div>
			)}
			<form className="chat-composer" onSubmit={send}>
				{!editing && <ChatImagePreviews state={state} />}
				<Textarea
					aria-label="メッセージ"
					value={draft}
					onChange={(event) => editInput(event.target.value)}
					onKeyDown={(event) => {
						if ((event.metaKey || event.ctrlKey) && event.key === "Enter")
							event.currentTarget.form?.requestSubmit();
						else if (editing && event.key === "Escape") {
							event.preventDefault();
							edit.stop();
						} else if (
							!editing &&
							event.key === "ArrowUp" &&
							!draft &&
							edit.target
						) {
							event.preventDefault();
							edit.start();
						}
					}}
					placeholder={
						state.specialist.addressee.kind === "specialist"
							? `${state.specialist.addressee.label}へのメッセージを入力、または話しかけてください`
							: "メッセージを入力、または話しかけてください"
					}
					maxLength={8000}
					rows={3}
				/>
				<div className="composer-actions">
					{!editing && <ChatImageInput state={state} />}
					<div className="voice-controls">
						<Button
							type="button"
							variant={voice.active ? "destructive" : "secondary"}
							onClick={() =>
								void (voice.active
									? voice.pause()
									: (replay.stop(), voice.start()))
							}
							disabled={!voice.active && (phase !== "idle" || !!editing)}
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
					{editing ? (
						<Button type="submit" disabled={!draft.trim() || edit.pending}>
							更新して送信
						</Button>
					) : (
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
					)}
				</div>
			</form>
			{(submit.isError || voice.error || audioError) && (
				<p className="chat-error" role="alert">
					{submit.isError
						? submit.error instanceof ApiError &&
							submit.error.message === "addressee_changed"
							? describeError(submit.error)
							: `送信できませんでした: ${describeError(submit.error)}`
						: voice.error || (audioError ? describeError(audioError) : null)}
				</p>
			)}
		</div>
	);
}
