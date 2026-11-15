/* eslint-disable jsx-a11y/no-noninteractive-tabindex, jsx-a11y/prefer-tag-over-role -- This labelled scroll region needs focus for keyboard history navigation. */
import { DebugDiagnostic } from "./DebugDiagnostic";
import { useCallback } from "react";
import type { EumenesClient } from "../../../client";
import type { Message } from "../../../api/domains/conversation/contracts";
import { ResourceChips } from "../domains/resources";
import { formatResourceUri } from "../../../api/domains/resources/contracts";
import { SCRATCH_RESOURCE_KIND } from "../../../api/domains/scratch/contracts";
import { LiveMessageList } from "./LiveMessageList";
import { ConversationFailures } from "./ConversationFailures";
import { RunDetails, RunFailure } from "./RunDetails";
import { ThinkingRow } from "./ThinkingRow";
import { LiveVoicePanel } from "../domains/live-voice";
import type { usePanelResources } from "./usePanelResources";
import type { WorkspaceState } from "./useWorkspace";

/**
 * The scrolling history. The render callbacks keep their identity while their data is unchanged, so the rows of the list
 * are not drawn again for anything but a change of their own.
 */
export function ConversationHistory({
	client,
	state,
	resources,
}: {
	client: EumenesClient;
	state: WorkspaceState;
	resources: ReturnType<typeof usePanelResources>;
}) {
	const {
		activeRun,
		conversation,
		replay,
		edit,
		runs,
		settings,
		debugMode,
		debugDiagnostics,
		historyRef,
		contentRef,
		showLatest,
		followLatestIfPinned,
		onHistoryScroll,
	} = state;
	const { openResource } = resources;
	const resourceData = resources.resources.data;
	const runList = runs.data;
	const agentName = settings.data?.general.agentName;
	const { playingId, play, stop } = replay;
	const onOpenResource = useCallback(
		(uri: string) => void openResource(uri),
		[openResource],
	);
	const renderInsideMessage = useCallback(
		(message: Message) =>
			message.role === "assistant" || message.role === "user" ? (
				<ResourceChips
					messageId={message.id}
					data={resourceData}
					onOpen={(uri, action) => void openResource(uri, action)}
					// A user's image is shown as the image itself; its other files and long paste are chips.
					exclude={
						new Set(
							(message.attachments ?? []).map((a) =>
								formatResourceUri(SCRATCH_RESOURCE_KIND, a.id),
							),
						)
					}
				/>
			) : null,
		[resourceData, openResource],
	);
	const debugEntries =
		debugMode && !debugDiagnostics.isError
			? debugDiagnostics.data?.entries
			: undefined;
	const renderFollowingMessage = useCallback(
		(message: Message) => (
			<>
				<RunDetails
					client={client}
					message={message}
					runs={runList}
					agentName={agentName}
				/>
				{message.role === "user" &&
					debugEntries
						?.filter((entry) =>
							runList?.some(
								(run) =>
									run.id === entry.runId && run.inputMessageId === message.id,
							),
						)
						.map((entry) => (
							<DebugDiagnostic
								key={entry.id}
								client={client}
								entry={entry}
								conversationId={message.conversationId}
							/>
						))}
			</>
		),
		[client, runList, agentName, debugEntries],
	);
	const renderHiddenMessage = useCallback(
		(message: Message) => (
			<RunFailure
				client={client}
				message={message}
				runs={runList}
				agentName={agentName}
			/>
		),
		[client, runList, agentName],
	);
	const onReplay = useCallback(
		(message: Pick<Message, "id" | "text" | "runId">) =>
			playingId === message.id
				? stop()
				: void play(message.id, message.text, message.runId),
		[playingId, play, stop],
	);
	return (
		<div
			className="chat-history"
			ref={historyRef}
			data-following-latest={!showLatest}
			role="region"
			tabIndex={0}
			aria-label="会話履歴"
			onScroll={(event) => onHistoryScroll(event.currentTarget)}
		>
			<div className="chat-history-content" ref={contentRef}>
				{debugMode && (
					<p className="agency-thought">
						デバッグモード
						{debugDiagnostics.data?.omitted
							? ` · 診断を${debugDiagnostics.data.omitted}件省略`
							: ""}
					</p>
				)}
				<LiveMessageList
					client={client}
					activeRunId={activeRun?.id}
					announcement={activeRun?.announcement}
					followLatestIfPinned={followLatestIfPinned}
					historyRef={historyRef}
					followLatest={!showLatest}
					conversation={conversation.data}
					thoughts={state.thoughts.data}
					onOpenResource={onOpenResource}
					renderInsideMessage={renderInsideMessage}
					renderFollowingMessage={renderFollowingMessage}
					renderHiddenMessage={renderHiddenMessage}
					editableId={edit.editing ? undefined : edit.target?.message.id}
					editingId={edit.editing?.id}
					editedIds={edit.editedIds}
					onEdit={edit.start}
					agentName={agentName}
					replayingId={playingId}
					onReplay={onReplay}
				/>
				{activeRun && <ThinkingRow state={state} run={activeRun} />}
				{state.live && (
					<LiveVoicePanel live={state.live} agentName={agentName} />
				)}
				<ConversationFailures state={state} />
			</div>
		</div>
	);
}
