import { spatialPreferences } from "../components/SpatialPreferences";
import {
	useVideoAdmission,
	videoAdmissionMessage,
} from "../domains/video/admission";
import { useMemo, useState } from "react";
import type { EumenesClient } from "../../../client";
import type { AudioStore } from "../domains/audio";
import { ConversationBackground } from "../components/ConversationBackground";
import { Subtitle } from "../components/domains/subtitle/Subtitle";
import { useMonitoringItems } from "../domains/monitoring";
import { useAvatarBackdrop } from "../domains/settings";
import { imageContentUrl } from "../media/use-image-library";
import { AvatarBackdropPicker } from "./AvatarBackdropPicker";
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
	onInspectContext,
}: {
	client: EumenesClient;
	store: AudioStore;
	state: WorkspaceState;
	/** Background mode: the chat stays mounted but hidden, and the background takes input. */
	chatHidden?: boolean;
	onInspectContext?(runId: string, trigger: HTMLButtonElement): void;
}) {
	const resources = usePanelResources(client, state);
	const admission = useVideoAdmission(client).data?.state;
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
	const avatarBackdrop = useAvatarBackdrop(client);
	const [backdropPicking, setBackdropPicking] = useState(false);
	const backdrop = {
		url: avatarBackdrop.imageId
			? imageContentUrl(avatarBackdrop.imageId)
			: null,
		color: avatarBackdrop.color,
		busy: avatarBackdrop.busy,
		onPick: () => setBackdropPicking(true),
		onClear: () => void avatarBackdrop.select(null),
		onColor: avatarBackdrop.selectColor,
		onReset: () => void avatarBackdrop.reset(),
	};
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
				backdrop={backdrop}
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
			{hiyori && (
				<AvatarBackdropPicker
					client={client}
					open={backdropPicking}
					selectedId={avatarBackdrop.imageId}
					onClose={() => setBackdropPicking(false)}
					onConfirm={(id) => void avatarBackdrop.select(id)}
				/>
			)}
			<ConversationStatusBar
				client={client}
				state={state}
				resourceNotice={resources.notice}
			/>
			<ConversationHistory
				client={client}
				state={state}
				resources={resources}
				onInspectContext={onInspectContext}
			/>
			{showLatest && (
				<button className="latest-button" type="button" onClick={scrollLatest}>
					最新の発言へ ↓
				</button>
			)}
			<ConversationComposer
				state={state}
				store={store}
				videoNotice={videoAdmissionMessage(admission)}
				videoBusy={admission === "active" || admission === "unconfirmed"}
			/>
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
