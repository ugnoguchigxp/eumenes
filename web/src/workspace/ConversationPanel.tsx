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
import { usePanelFileDrop } from "./usePanelFileDrop";
import { usePanelResources } from "./usePanelResources";
import { useScreenPresence } from "./useScreenPresence";
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
	useScreenPresence(client);
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
					画像を追加
				</div>
			)}
			<ConversationBackground
				kind={backgroundKind}
				spatial={spatial}
				items={monitored}
				interactive={chatHidden}
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
