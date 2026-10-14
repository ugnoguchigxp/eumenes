import { useEffect, useRef, useState } from "react";
import type { EumenesClient } from "../../../client";
import type { AudioStore } from "../domains/audio";
import { Button } from "../design-system";
import { MessageList } from "../components/domains/conversation/MessageList";
import { ConversationBackground } from "../components/ConversationBackground";
import { Subtitle } from "../components/domains/subtitle/Subtitle";
import { ResearchTaskCard } from "../domains/agent-runtime";
import { MusicResultLink } from "../domains/music/MusicResultLink";
import { useConversationModel } from "../domains/settings";
import { describeConnectionState } from "../errorMessages";
import { ConversationComposer } from "./ConversationComposer";
import type { WorkspaceState } from "./useWorkspace";

export function ConversationPanel({
	client,
	store,
	state,
}: {
	client: EumenesClient;
	store: AudioStore;
	state: WorkspaceState;
}) {
	const {
		settingsOpen,
		replay,
		voice,
		phase,
		activeRun,
		connectionState,
		actualModel,
		settings,
		status,
		connectionError,
		changesState,
		reconnect,
		conversation,
		historyRef,
		onHistoryScroll,
		runs,
		streamingText,
		cancel,
		showLatest,
		scrollLatest,
	} = state;
	const model = useConversationModel(client);
	const panel = useRef<HTMLElement>(null);
	const depth = useRef(0);
	const [dragging, setDragging] = useState(false);
	useEffect(() => {
		function paste(event: ClipboardEvent) {
			const target = document.activeElement;
			if (
				settingsOpen ||
				document.querySelector('[role="dialog"][data-state="open"]') ||
				(target !== document.body && !panel.current?.contains(target))
			)
				return;
			const files = Array.from(event.clipboardData?.files ?? []);
			if (!files.length) return;
			event.preventDefault();
			state.attachments.add(files);
			const text = event.clipboardData?.getData("text/plain");
			if (text && target instanceof HTMLTextAreaElement) {
				const start = target.selectionStart;
				const end = target.selectionEnd;
				state.editInput(
					target.value.slice(0, start) + text + target.value.slice(end),
				);
				requestAnimationFrame(() =>
					target.setSelectionRange(start + text.length, start + text.length),
				);
			}
		}
		const element = panel.current;
		const enter = (e: DragEvent) => {
			if (e.dataTransfer?.types.includes("Files")) {
				e.preventDefault();
				depth.current++;
				setDragging(true);
			}
		};
		const leave = (e: DragEvent) => {
			if (e.dataTransfer?.types.includes("Files") && --depth.current <= 0) {
				depth.current = 0;
				setDragging(false);
			}
		};
		const over = (e: DragEvent) => {
			if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
		};
		const drop = (e: DragEvent) => {
			if (e.dataTransfer?.files.length) {
				e.preventDefault();
				depth.current = 0;
				setDragging(false);
				state.attachments.add(Array.from(e.dataTransfer.files));
			}
		};
		document.addEventListener("paste", paste);
		element?.addEventListener("dragenter", enter);
		element?.addEventListener("dragleave", leave);
		element?.addEventListener("dragover", over);
		element?.addEventListener("drop", drop);
		return () => {
			document.removeEventListener("paste", paste);
			element?.removeEventListener("dragenter", enter);
			element?.removeEventListener("dragleave", leave);
			element?.removeEventListener("dragover", over);
			element?.removeEventListener("drop", drop);
		};
	}, [settingsOpen, state]);
	const lastUsed = actualModel
		? `直近の利用: ${actualModel.source === "cloud" ? "クラウド" : "LARM"} / ${actualModel.model}`
		: undefined;
	const subtitleText =
		replay.subtitle ?? (phase === "playing" ? voice.subtitle : null);
	const subtitles = settings.data?.general.subtitles;
	return (
		<section ref={panel} className="chat-panel" aria-label="会話">
			{dragging && (
				<div className="chat-drop-target" aria-live="polite">
					画像を追加
				</div>
			)}
			<ConversationBackground
				kind={settings.data?.general.background ?? "light-fairy"}
				active={!settingsOpen && !settings.isPending}
				cue={replay.avatarCue ?? voice.avatarCue}
				phase={
					phase === "playing"
						? "neutral"
						: activeRun
							? "thinking"
							: voice.active
								? "listening"
								: "neutral"
				}
			/>
			<div className="conversation-status" aria-label="接続状態とモデル">
				<span
					className="connection-health"
					data-state={connectionState}
					aria-label={`LARMの接続状態: ${describeConnectionState(connectionState)}`}
				>
					<i className="health-dot" aria-hidden="true" />
					<span>LARM</span>
					<span className="health-state">
						{describeConnectionState(connectionState)}
					</span>
				</span>
				{model.ready ? (
					<select
						className="model-label model-select"
						aria-label="会話モデル"
						title={lastUsed}
						value={model.selected}
						disabled={model.busy}
						onChange={(e) => void model.select(e.target.value)}
					>
						{model.options.map((o) => (
							<option key={o.id} value={o.id}>
								{o.label}
							</option>
						))}
					</select>
				) : (
					<span className="model-label">
						{actualModel?.source === "cloud" && "クラウド / "}
						{actualModel?.model}
					</span>
				)}
			</div>
			{model.error && (
				<p className="chat-error" role="alert">
					{model.error}
				</p>
			)}
			{status.isError && (
				<p className="chat-error" role="alert">
					ローカル API に接続できません。Eumenes の backend
					と設定を確認してください。
				</p>
			)}
			{connectionError && (
				<p className="chat-error" role="alert">
					LARM に接続できませんでした: {connectionError}
				</p>
			)}
			{changesState === "failed" && !status.isError && (
				<p className="chat-error" role="alert">
					更新情報に接続できません。文字起こしや回答の表示が遅れる場合があります。
				</p>
			)}
			{(status.isError ||
				changesState === "failed" ||
				["failed", "unconfigured", "idle"].includes(
					status.data?.larm.state ?? "",
				)) && (
				<Button
					variant="secondary"
					onClick={() => reconnect.mutate()}
					disabled={reconnect.isPending}
				>
					{reconnect.isPending ? "接続を確認中" : "接続を再確認"}
				</Button>
			)}
			{replay.error && (
				<p className="chat-error" role="alert">
					{replay.error}
				</p>
			)}
			{conversation.isError && (
				<p className="chat-error" role="alert">
					会話履歴を取得できませんでした。
				</p>
			)}
			<div
				className="chat-history"
				ref={historyRef}
				onScroll={(event) => onHistoryScroll(event.currentTarget)}
			>
				<MessageList
					client={client}
					conversation={conversation.data}
					renderInsideMessage={(message) =>
						message.role === "assistant" ? (
							<MusicResultLink
								runId={message.runId}
								items={state.musicItems}
								onOpen={state.openMusic}
							/>
						) : null
					}
					renderFollowingMessage={(message) => {
						const run = runs.data?.find((r) => r.inputMessageId === message.id);
						return run?.agentTaskId ? (
							<ResearchTaskCard
								client={client}
								rootRunId={run.id}
								title={message.text}
							/>
						) : null;
					}}
					streaming={streamingText}
					agentName={settings.data?.general.agentName}
					replayingId={replay.playingId}
					onReplay={(message) =>
						replay.playingId === message.id
							? replay.stop()
							: void replay.play(message.id, message.text, message.runId)
					}
				/>
				{activeRun && (
					<div className="thinking">
						<span className="thinking-dots" aria-hidden="true">
							<i />
							<i />
							<i />
						</span>
						<output>
							{activeRun.status === "queued" ? "応答を準備中" : "回答を作成中"}
						</output>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => cancel.mutate(activeRun.id)}
							disabled={cancel.isPending}
						>
							中止
						</Button>
					</div>
				)}
			</div>
			{showLatest && (
				<button className="latest-button" type="button" onClick={scrollLatest}>
					最新の発言へ ↓
				</button>
			)}
			<ConversationComposer state={state} store={store} />
			{subtitles?.enabled && subtitleText && (
				<Subtitle
					text={subtitleText}
					style={subtitles.style}
					size={subtitles.size}
				/>
			)}
		</section>
	);
}
