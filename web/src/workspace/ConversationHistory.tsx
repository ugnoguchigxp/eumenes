import { useCallback } from "react";
import type { EumenesClient } from "../../../client";
import type { Message } from "../../../api/domains/conversation/contracts";
import { ResourceChips } from "../domains/resources";
import { LiveMessageList } from "./LiveMessageList";
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
		historyRef,
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
			message.role === "assistant" ? (
				<ResourceChips
					messageId={message.id}
					data={resourceData}
					onOpen={(uri, action) => void openResource(uri, action)}
				/>
			) : null,
		[resourceData, openResource],
	);
	const renderFollowingMessage = useCallback(
		(message: Message) => (
			<RunDetails
				client={client}
				message={message}
				runs={runList}
				agentName={agentName}
			/>
		),
		[client, runList, agentName],
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
			onScroll={(event) => onHistoryScroll(event.currentTarget)}
		>
			<LiveMessageList
				client={client}
				activeRunId={activeRun?.id}
				announcement={activeRun?.announcement}
				followLatestIfPinned={state.followLatestIfPinned}
				conversation={conversation.data}
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
			{state.live && <LiveVoicePanel live={state.live} />}
		</div>
	);
}
