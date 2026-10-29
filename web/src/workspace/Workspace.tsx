import { lazy, Suspense, useState } from "react";
import type { EumenesClient } from "../../../client";
import type { AudioStore } from "../domains/audio";
import { ArtifactLauncher } from "../components/domains/artifact/ArtifactLauncher";
import { ResizableWorkspace } from "../components/domains/artifact/ResizableWorkspace";
import { TimerNotifications } from "../components/domains/timers/TimerNotifications";
import type { TodoNotifications } from "../components/domains/timers/NotificationCenter";
import { useResourceNotice, useResourceOpener } from "../domains/resources";
import { useWorkspaceLauncher } from "./usePanelResources";
import { ChatVisibilityToggle } from "./ChatVisibilityToggle";
import { ConversationPanel } from "./ConversationPanel";
import { SpecialistCloseConfirm } from "./SpecialistCloseConfirm";
import { SpecialistBridgeContext } from "../domains/toolchain-artifacts/specialist-bridge";
import { useWorkspace } from "./useWorkspace";
import {
	artifactIdOf,
	entryLabel,
	menuEntries,
} from "../domains/toolchain-artifacts";

const WorkspaceArtifacts = lazy(() => import("./WorkspaceArtifacts"));

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
		todoNotices,
		voice,
		mute,
		settings,
		activeRun,
		replay,
		artifacts,
		specialist,
	} = state;
	// A finished TODO's notice opens what the work made or its toolchain's screen and reads the notice; a refusal
	// clears itself.
	const launcher = useWorkspaceLauncher(client, state);
	const openNotice = useResourceNotice();
	const openResource = useResourceOpener({
		client,
		launcher,
		notify: openNotice.show,
	});
	const todo: TodoNotifications = {
		...todoNotices,
		error: openNotice.notice ?? todoNotices.error,
		onOpen: (notice, target) => {
			openNotice.dismiss();
			if ("uri" in target) void openResource(target.uri);
			else void toolchain.openById(target.artifactId);
			if (!notice.read) void todoNotices.onRead(notice);
		},
	};
	// Background mode is a view state only: a reload shows the chat again.
	const [chatHidden, setChatHidden] = useState(false);
	const fullscreen =
		artifacts.active?.kind === "toolchain" &&
		artifactIdOf(artifacts.active.artifactRevisionId) ===
			"settings.service-tests";
	return (
		<main className="app-shell">
			{!fullscreen && (
				<ChatVisibilityToggle
					hidden={chatHidden}
					onToggle={() => setChatHidden((hidden) => !hidden)}
				/>
			)}
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
				todo={todo}
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
				fullscreen={fullscreen}
				artifact={
					artifacts.tabs.length > 0 ? (
						<Suspense
							fallback={
								<output className="artifact-loading">
									アーティファクトを読み込み中です。
								</output>
							}
						>
							<SpecialistBridgeContext.Provider value={specialist.bridge}>
								<WorkspaceArtifacts
									client={client}
									artifacts={artifacts}
									onCloseTab={specialist.closeTab}
								/>
							</SpecialistBridgeContext.Provider>
						</Suspense>
					) : null
				}
			>
				<ConversationPanel
					client={client}
					store={store}
					state={state}
					chatHidden={chatHidden}
				/>
			</ResizableWorkspace>
			<SpecialistCloseConfirm confirm={specialist.confirm} />
		</main>
	);
}
