import { lazy, Suspense, useCallback, useRef, useState } from "react";
import type { EumenesClient } from "../../../client";
import type { AudioStore } from "../domains/audio";
import { ArtifactLauncher } from "../components/domains/artifact/ArtifactLauncher";
import { ResizableWorkspace } from "../components/domains/artifact/ResizableWorkspace";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { TimerNotifications } from "../components/domains/timers/TimerNotifications";
import type { TodoNotifications } from "../components/domains/timers/NotificationCenter";
import { useResourceNotice, useResourceOpener } from "../domains/resources";
import { useWorkspaceLauncher } from "./usePanelResources";
import { ChatVisibilityToggle } from "./ChatVisibilityToggle";
import { ConversationPanel } from "./ConversationPanel";
import { SpecialistCloseConfirm } from "./SpecialistCloseConfirm";
import { SpecialistBridgeContext } from "../domains/toolchain-artifacts/specialist-bridge";
import { useWorkspace } from "./useWorkspace";
import { Button } from "../design-system";
import type { ContextSelection } from "./ConversationContextPanel";
import {
	artifactIdOf,
	entryLabel,
	menuEntries,
} from "../domains/toolchain-artifacts";

const WorkspaceArtifacts = lazy(() => import("./WorkspaceArtifacts"));
const ConversationContextPanel = lazy(() =>
	import("./ConversationContextPanel").then((module) => ({
		default: module.ConversationContextPanel,
	})),
);

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
	const launcher = useWorkspaceLauncher(state);
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
	const contextTrigger = useRef<HTMLButtonElement | null>(null);
	const contextAvailable = state.debugMode && !fullscreen && !chatHidden;
	const contextScope = contextAvailable ? client.identity : null;
	const [contextState, setContextState] = useState<{
		scope: string | null;
		selection: ContextSelection | null;
	}>({ scope: contextScope, selection: null });
	if (contextState.scope !== contextScope)
		setContextState({ scope: contextScope, selection: null });
	const contextSelection =
		contextState.scope === contextScope ? contextState.selection : null;
	const contextOpen = contextSelection !== null;
	const selectContext = useCallback(
		(selection: ContextSelection | null) =>
			setContextState({ scope: contextScope, selection }),
		[contextScope],
	);
	const openReplyContext = useCallback(
		(runId: string, trigger: HTMLButtonElement) => {
			contextTrigger.current = trigger;
			selectContext({ mode: "fixed", runId });
		},
		[selectContext],
	);
	const closeContext = useCallback(() => {
		selectContext(null);
		contextTrigger.current?.focus();
	}, [selectContext]);
	const latestContextRun = activeRun?.id ?? state.runs.data?.at(-1)?.id;
	const inspectedRun =
		contextSelection?.mode === "fixed"
			? contextSelection.runId
			: latestContextRun;
	const answerId = state.runs.data?.find(
		(run) => run.id === inspectedRun,
	)?.answerMessageId;
	const inspectedAnswer = state.conversation.data?.messages.find(
		(message) => message.id === answerId,
	)?.text;
	return (
		<main
			className="app-shell"
			data-context-open={contextOpen || undefined}
			data-context-available={contextAvailable || undefined}
		>
			{!fullscreen && (
				<div className="conversation-view-controls">
					{contextAvailable && (
						<Button
							type="button"
							variant="secondary"
							size="icon"
							className="conversation-context-trigger"
							title="コンテキスト"
							aria-label="コンテキスト"
							aria-expanded={contextOpen}
							aria-controls={contextOpen ? "conversation-context" : undefined}
							onClick={(event) => {
								if (contextOpen) closeContext();
								else {
									contextTrigger.current = event.currentTarget;
									selectContext({ mode: "latest" });
								}
							}}
						>
							<svg
								width="20"
								height="20"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="1.7"
								strokeLinecap="round"
								strokeLinejoin="round"
								aria-hidden="true"
							>
								<path d="M12 5.5a3.5 3.5 0 0 0-7 0A4 4 0 0 0 3.5 12 4 4 0 0 0 5 18.5a3.5 3.5 0 0 0 7 0m0-13a3.5 3.5 0 0 1 7 0 4 4 0 0 1 1.5 6.5 4 4 0 0 1-1.5 6.5 3.5 3.5 0 0 1-7 0m0-13v13M5 5.5c0 1.5.5 2.5 2 3m12-3c0 1.5-.5 2.5-2 3M5 18.5c0-1.5.5-2.5 2-3m12 3c0-1.5-.5-2.5-2-3" />
							</svg>
						</Button>
					)}
					<ChatVisibilityToggle
						hidden={chatHidden}
						onToggle={() => setChatHidden((hidden) => !hidden)}
					/>
				</div>
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
				playTone={(signal, message, delivered, onTurn) =>
					timerAudio.play(signal, message, delivered, false, undefined, onTurn)
				}
				repeatTone={timerAudio.repeat}
				audioReady={timerAudio.ready}
				prepareAudio={timerAudio.prepare}
				kanban={kanbanNotices}
				todo={todo}
				inputBusy={() => voice.audio()?.isInputBusy?.() ?? false}
				muted={mute.muted || settings.data?.voice.outputVolume === 0}
				busy={
					// Another screen plays sound: this one never claims a notice.
					!state.playbackScreen ||
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
					onInspectContext={contextAvailable ? openReplyContext : undefined}
				/>
			</ResizableWorkspace>
			{contextSelection && (
				<ErrorBoundary label="会話の入力" onReset={closeContext}>
					<Suspense fallback={<output>会話の入力を読み込んでいます</output>}>
						<ConversationContextPanel
							key={client.identity}
							client={client}
							selection={contextSelection}
							latestRunId={latestContextRun}
							answer={inspectedAnswer}
							disconnected={state.changesState === "failed"}
							onSelect={selectContext}
							onClose={closeContext}
						/>
					</Suspense>
				</ErrorBoundary>
			)}
			<SpecialistCloseConfirm confirm={specialist.confirm} />
		</main>
	);
}
