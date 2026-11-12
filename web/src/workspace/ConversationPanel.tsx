import { spatialPreferences } from "../components/SpatialPreferences";
import { useMemo } from "react";
import type { EumenesClient } from "../../../client";
import type { AudioStore } from "../domains/audio";
import { ConversationBackground } from "../components/ConversationBackground";
import { Subtitle } from "../components/domains/subtitle/Subtitle";
import { useMonitoringItems } from "../domains/monitoring";
import { ConversationComposer } from "./ConversationComposer";
import { ConversationHistory } from "./ConversationHistory";
import { ConversationStatusBar } from "./ConversationStatusBar";
import { useAnswerAvatarCue } from "./useAnswerAvatarCue";
import { usePanelFileDrop } from "./usePanelFileDrop";
import { usePanelResources } from "./usePanelResources";
import { ScratchViewer } from "./ScratchViewer";
import type { WorkspaceState } from "./useWorkspace";

export function ConversationPanel({
	client,
	store,
	state,
	chatHidden = false,
}: {
	client: EumenesClient;
	store: AudioStore;
	state: WorkspaceState;
	/** Background mode: the chat stays mounted but hidden, and the background takes input. */
	chatHidden?: boolean;
}) {
	const resources = usePanelResources(client, state);
	const { panel, dragging } = usePanelFileDrop(state);
	const {
		replay,
		voice,
		phase,
		activeRun,
		settings,
		showLatest,
		scrollLatest,
	} = state;
	const subtitleText =
		replay.subtitle ?? (phase === "playing" ? voice.subtitle : null);
	const subtitles = settings.data?.general.subtitles;
	const backgroundKind = settings.data?.general.background ?? "light-fairy";
	const hiyori = backgroundKind === "live2d-hiyori";
	const answerCue = useAnswerAvatarCue(
		state.conversation.data?.messages,
		!hiyori || !!replay.avatarCue || !!voice.avatarCue || state.live.playing,
	);
	const replayCue =
		hiyori || replay.avatarCue?.speaking ? replay.avatarCue : null;
	const voiceCue = hiyori || voice.avatarCue?.speaking ? voice.avatarCue : null;
	const monitored = useMonitoringItems(
		client,
		backgroundKind === "spatial" && !settings.isPending,
	);
	const spatial = useMemo(
		() => spatialPreferences(settings.data?.general),
		[settings.data?.general],
	);
	return (
		<section
			ref={panel}
			className="chat-panel"
			data-chat-hidden={chatHidden || undefined}
			aria-label="会話"
		>
			{dragging && (
				<div className="chat-drop-target" aria-live="polite">
					ファイルを追加
				</div>
			)}
			<ConversationBackground
				kind={backgroundKind}
				spatial={spatial}
				items={monitored}
				interactive={chatHidden}
				active={!settings.isPending}
				cue={replayCue ?? voiceCue ?? answerCue}
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
			<ConversationStatusBar
				client={client}
				state={state}
				resourceNotice={resources.notice}
			/>
			<ConversationHistory
				client={client}
				state={state}
				resources={resources}
			/>
			{showLatest && (
				<button className="latest-button" type="button" onClick={scrollLatest}>
					最新の発言へ ↓
				</button>
			)}
			<ConversationComposer state={state} store={store} />
			<ScratchViewer
				client={client}
				id={resources.scratch.id}
				onClose={resources.scratch.close}
			/>
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
