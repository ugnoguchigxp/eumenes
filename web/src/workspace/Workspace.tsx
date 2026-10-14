import type { EumenesClient } from "../../../client";
import type { AudioStore } from "../domains/audio";
import { ArtifactLauncher } from "../components/domains/artifact/ArtifactLauncher";
import { ResizableWorkspace } from "../components/domains/artifact/ResizableWorkspace";
import { TimerNotifications } from "../components/domains/timers/TimerNotifications";
import { WorkspaceArtifacts } from "./WorkspaceArtifacts";
import { ConversationPanel } from "./ConversationPanel";
import { useWorkspace } from "./useWorkspace";
import {
	artifactIdOf,
	entryLabel,
	menuEntries,
} from "../domains/toolchain-artifacts";

export function Workspace({
	client,
	store,
}: {
	client: EumenesClient;
	store: AudioStore;
}) {
	const state = useWorkspace({ client, store });
	const {
		openDrawing,
		openPlaylist,
		toolchain,
		timerAudio,
		kanbanNotices,
		voice,
		mute,
		settings,
		activeRun,
		replay,
		artifacts,
	} = state;
	return (
		<main className="app-shell">
			<ArtifactLauncher
				entries={[
					{ label: "図を描く・編集する", onSelect: openDrawing },
					{ label: "音楽プレイリスト", onSelect: openPlaylist },
					...menuEntries(toolchain.entries).map((entry) => ({
						label: entryLabel(entry),
						onSelect: () => toolchain.openEntry(entry),
					})),
				]}
			/>
			<TimerNotifications
				client={client}
				playTone={timerAudio.play}
				repeatTone={timerAudio.repeat}
				audioReady={timerAudio.ready}
				prepareAudio={timerAudio.prepare}
				kanban={kanbanNotices}
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
			<ResizableWorkspace
				fullscreen={
					artifacts.active?.kind === "toolchain" &&
					artifactIdOf(artifacts.active.artifactRevisionId) ===
						"settings.service-tests"
				}
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
