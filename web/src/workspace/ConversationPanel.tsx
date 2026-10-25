import { spatialPreferences } from "../components/SpatialPreferences";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import type { EumenesClient } from "../../../client";
import type { AudioStore } from "../domains/audio";
import { Button } from "../design-system";
import { LiveMessageList } from "./LiveMessageList";
import { ConversationBackground } from "../components/ConversationBackground";
import { Subtitle } from "../components/domains/subtitle/Subtitle";
import { RunDetails, RunFailure } from "./RunDetails";
import { useBackground, useConversationModel } from "../domains/settings";
import { useSpeechModels } from "../domains/settings/useSpeechModels";
import { SpeechModelSelect } from "./SpeechModelSelect";
import { ConversationModelSelect } from "./ConversationModelSelect";
import { BackgroundSelect } from "./BackgroundSelect";
import { describeConnectionState } from "../errorMessages";
import { useMonitoringItems } from "../domains/monitoring";
import { ConversationComposer } from "./ConversationComposer";
import type { WorkspaceState } from "./useWorkspace";
import { useScreenPresence } from "./useScreenPresence";
import { ThinkingRow } from "./ThinkingRow";
import {
	MUSIC_PLAYLIST_ADAPTER_REF,
	musicPlaylistScreen,
} from "../domains/music/playlist-screen";
import {
	ResourceChips,
	useConversationResources,
	useResourceNotice,
	useResourceOpener,
	type ResourceLauncher,
} from "../domains/resources";
import {
	DRAWING_ADAPTER_REF,
	drawingScreen,
} from "../domains/excalidraw/resource-screen";
import { toolchainArtifactsQuery } from "../domains/toolchain-artifacts/launcher";
import { toolchainWebAdapters } from "./toolchain-adapters";

const CONVERSATION_ID = "main";

export function ConversationPanel({
	client,
	store,
	state,
}: {
	client: EumenesClient;
	store: AudioStore;
	state: WorkspaceState;
}) {
	useScreenPresence(client);
	const cache = useQueryClient();
	const { openByAdapter } = state.toolchain;
	const { openPlaylist, openDrawing } = state;
	// How a resource reaches a screen: the registered artifact of its adapter, or the playlist or drawing tab.
	const launcher = useMemo<ResourceLauncher>(
		() => ({
			open: async (adapterRef, targetRef) => {
				if (adapterRef === MUSIC_PLAYLIST_ADAPTER_REF) {
					openPlaylist(targetRef);
					return true;
				}
				if (adapterRef === DRAWING_ADAPTER_REF) {
					openDrawing();
					return true;
				}
				const entries = await cache
					.fetchQuery(toolchainArtifactsQuery(client))
					.catch(() => []);
				if (!entries.some((entry) => entry.adapterRef === adapterRef))
					return false;
				await openByAdapter(adapterRef, targetRef);
				return true;
			},
			screen: (adapterRef) =>
				adapterRef === MUSIC_PLAYLIST_ADAPTER_REF
					? musicPlaylistScreen
					: adapterRef === DRAWING_ADAPTER_REF
						? drawingScreen
						: toolchainWebAdapters.get(adapterRef),
		}),
		[cache, client, openByAdapter, openPlaylist, openDrawing],
	);
	const resourceNotice = useResourceNotice();
	const openResource = useResourceOpener({
		client,
		launcher,
		notify: resourceNotice.show,
	});
	const resources = useConversationResources(client, CONVERSATION_ID);
	const {
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
		followLatestIfPinned,
		showLatest,
		scrollLatest,
	} = state;
	const model = useConversationModel(client);
	const speechModels = useSpeechModels(client);
	const background = useBackground(client);
	const panel = useRef<HTMLElement>(null);
	const depth = useRef(0);
	const [dragging, setDragging] = useState(false);
	// The listeners below attach once; they read the latest callbacks through this ref.
	const latest = useRef({
		add: state.attachments.add,
		edit: state.editInput,
	});
	useEffect(() => {
		latest.current = { add: state.attachments.add, edit: state.editInput };
	});
	useEffect(() => {
		function paste(event: ClipboardEvent) {
			const target = document.activeElement;
			if (
				document.querySelector('[role="dialog"][data-state="open"]') ||
				(target !== document.body && !panel.current?.contains(target))
			)
				return;
			const files = Array.from(event.clipboardData?.files ?? []);
			if (!files.length) return;
			event.preventDefault();
			latest.current.add(files);
			const text = event.clipboardData?.getData("text/plain");
			if (text && target instanceof HTMLTextAreaElement) {
				const start = target.selectionStart;
				const end = target.selectionEnd;
				latest.current.edit(
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
				latest.current.add(Array.from(e.dataTransfer.files));
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
	}, []);
	const subtitleText =
		replay.subtitle ?? (phase === "playing" ? voice.subtitle : null);
	const subtitles = settings.data?.general.subtitles;
	const backgroundKind = settings.data?.general.background ?? "light-fairy";
	const monitored = useMonitoringItems(
		client,
		backgroundKind === "spatial" && !settings.isPending,
	);
	const spatial = useMemo(
		() => spatialPreferences(settings.data?.general),
		[settings.data?.general],
	);
	return (
		<section ref={panel} className="chat-panel" aria-label="会話">
			{dragging && (
				<div className="chat-drop-target" aria-live="polite">
					画像を追加
				</div>
			)}
			<ConversationBackground
				kind={backgroundKind}
				spatial={spatial}
				items={monitored}
				active={!settings.isPending}
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
					className="conversation-addressee"
					data-kind={state.specialist.addressee.kind}
				>
					<span className="conversation-addressee-label">宛先</span>
					<strong>{state.specialist.addressee.label}</strong>
					{state.specialist.addressee.kind === "normal" &&
						state.specialist.addressee.suspended && (
							<span className="conversation-addressee-hold">
								（{state.specialist.addressee.suspended}は一時保留）
							</span>
						)}
				</span>
				<ConversationModelSelect
					model={model}
					running={!!activeRun || speechModels.busy}
					actualModel={actualModel}
				/>
				<SpeechModelSelect
					models={speechModels}
					disabled={
						!!activeRun ||
						model.busy ||
						voice.active ||
						phase === "playing" ||
						replay.playingId !== null
					}
				/>
				<BackgroundSelect background={background} />
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
			</div>
			{state.specialist.notice && (
				<output className="conversation-notice">
					<span>{state.specialist.notice}</span>
					<Button
						variant="ghost"
						size="sm"
						onClick={state.specialist.dismissNotice}
					>
						閉じる
					</Button>
				</output>
			)}
			{resourceNotice.notice && (
				<output className="conversation-notice">
					<span>{resourceNotice.notice}</span>
					<Button variant="ghost" size="sm" onClick={resourceNotice.dismiss}>
						閉じる
					</Button>
				</output>
			)}
			{(model.error || speechModels.error || background.error) && (
				<p className="chat-error" role="alert">
					{model.error || speechModels.error || background.error}
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
				<LiveMessageList
					client={client}
					activeRunId={activeRun?.id}
					announcement={activeRun?.announcement}
					followLatestIfPinned={followLatestIfPinned}
					conversation={conversation.data}
					onOpenResource={(uri) => void openResource(uri)}
					renderInsideMessage={(message) =>
						message.role === "assistant" ? (
							<ResourceChips
								messageId={message.id}
								data={resources.data}
								onOpen={(uri, action) => void openResource(uri, action)}
							/>
						) : null
					}
					renderFollowingMessage={(message) => (
						<RunDetails
							client={client}
							message={message}
							runs={runs.data}
							agentName={settings.data?.general.agentName}
						/>
					)}
					renderHiddenMessage={(message) => (
						<RunFailure
							client={client}
							message={message}
							runs={runs.data}
							agentName={settings.data?.general.agentName}
						/>
					)}
					editableId={
						state.edit.editing ? undefined : state.edit.target?.message.id
					}
					editingId={state.edit.editing?.id}
					editedIds={state.edit.editedIds}
					onEdit={state.edit.start}
					agentName={settings.data?.general.agentName}
					replayingId={replay.playingId}
					onReplay={(message) =>
						replay.playingId === message.id
							? replay.stop()
							: void replay.play(message.id, message.text, message.runId)
					}
				/>
				{activeRun && <ThinkingRow state={state} run={activeRun} />}
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
