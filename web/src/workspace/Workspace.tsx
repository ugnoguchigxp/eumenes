import { SettingsDraftProvider } from "../domains/settings/SettingsDraftHost";
import type { EumenesClient } from "../../../client";
import type { AudioStore } from "../domains/audio";
import { Button } from "../design-system";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { ArtifactLauncher } from "../components/domains/artifact/ArtifactLauncher";
import { ResizableWorkspace } from "../components/domains/artifact/ResizableWorkspace";
import { TimerNotifications } from "../components/domains/timers/TimerNotifications";
import { invalidateAllButLive } from "../queryKeys";
import { SettingsContent } from "./SettingsContent";
import { WorkspaceArtifacts } from "./WorkspaceArtifacts";
import { ConversationPanel } from "./ConversationPanel";
import { useWorkspace } from "./useWorkspace";
import { entryLabel, menuEntries } from "../domains/toolchain-artifacts";

function WorkspaceContent({
	client,
	store,
}: {
	client: EumenesClient;
	store: AudioStore;
}) {
	const state = useWorkspace({ client, store });
	const {
		settingsOpen,
		openDrawing,
		openImage,
		openRecognition,
		openPlaylist,
		toolchain,
		openShowcase,
		timerAudio,
		voice,
		mute,
		settings,
		activeRun,
		replay,
		onDirty,
		cache,
		artifacts,
	} = state;
	return (
		<main className="app-shell">
			<Button
				className={`floating-settings${settingsOpen ? " floating-settings-close" : ""}`}
				variant="secondary"
				size="icon"
				aria-label={settingsOpen ? "会話に戻る" : "設定"}
				title={settingsOpen ? "会話に戻る" : "設定"}
				onClick={() => {
					window.location.hash = settingsOpen ? "conversation" : "settings";
				}}
			>
				<svg
					width="22"
					height="22"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth={settingsOpen ? 2.2 : 1.8}
					strokeLinecap="round"
					strokeLinejoin="round"
					aria-hidden="true"
				>
					{settingsOpen ? (
						<path d="M6 6l12 12M18 6 6 18" />
					) : (
						<>
							<path d="m9.5 3-.5 2-2 1.2-2-.6-2.5 4.3L4 11.3v2l-1.5 1.4L5 19l2-.6 2 1.2.5 2.4h5l.5-2.4 2-1.2 2 .6 2.5-4.3-1.5-1.4v-2l1.5-1.4L19 5.6l-2 .6L15 5l-.5-2z" />
							<circle cx="12" cy="12" r="3" />
						</>
					)}
				</svg>
			</Button>
			{!settingsOpen && (
				<ArtifactLauncher
					entries={[
						{ label: "画像生成", onSelect: openImage },
						{ label: "図を描く・編集する", onSelect: openDrawing },
						{ label: "映っている物を調べる", onSelect: openRecognition },
						{ label: "音楽プレイリスト", onSelect: openPlaylist },
						...menuEntries(toolchain.entries).map((entry) => ({
							label: entryLabel(entry),
							onSelect: () => toolchain.openEntry(entry),
						})),
						{ label: "UIショーケース", onSelect: openShowcase },
					]}
				/>
			)}
			<TimerNotifications
				client={client}
				playTone={timerAudio.play}
				repeatTone={timerAudio.repeat}
				audioReady={timerAudio.ready}
				prepareAudio={timerAudio.prepare}
				inputBusy={() => voice.audio()?.isInputBusy?.() ?? false}
				muted={mute.muted || settings.data?.voice.outputVolume === 0}
				busy={
					!mute.ready ||
					settings.isPending ||
					!!activeRun ||
					(!!voice.turn &&
						["recognizing", "responding", "synthesizing", "ready"].includes(
							voice.turn.status,
						)) ||
					replay.playingId !== null
				}
			/>
			{settingsOpen && (
				<ErrorBoundary label="settings">
					<SettingsContent
						client={client}
						onDirty={onDirty}
						onSaved={() => {
							void invalidateAllButLive(cache);
						}}
					/>
				</ErrorBoundary>
			)}
			<ResizableWorkspace
				hidden={settingsOpen}
				artifact={
					artifacts.tabs.length > 0 ? (
						<WorkspaceArtifacts client={client} artifacts={artifacts} />
					) : null
				}
			>
				<ConversationPanel client={client} store={store} state={state} />
			</ResizableWorkspace>
		</main>
	);
}

export function Workspace(props: Parameters<typeof WorkspaceContent>[0]) {
	return (
		<SettingsDraftProvider key={props.client.identity} client={props.client}>
			<WorkspaceContent {...props} />
		</SettingsDraftProvider>
	);
}
