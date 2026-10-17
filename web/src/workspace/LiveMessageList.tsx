import { useEffect, type ComponentProps } from "react";
import type { EumenesClient } from "../../../client";
import { MessageList } from "../components/domains/conversation/MessageList";
import { useRunProgress } from "../domains/dialogue";

/**
 * Owns the streamed-token subscription: each token re-renders only this list,
 * not the workspace that holds the rest of the conversation screen.
 */
export function LiveMessageList({
	client,
	activeRunId,
	announcement,
	followLatestIfPinned,
	...list
}: Omit<ComponentProps<typeof MessageList>, "streaming"> & {
	client: EumenesClient;
	activeRunId: string | undefined;
	announcement?: string | null;
	followLatestIfPinned: () => void;
}) {
	const streaming = useRunProgress(client, activeRunId);
	const messageCount = list.conversation?.messages.length ?? 0;
	useEffect(() => {
		followLatestIfPinned();
	}, [
		messageCount,
		activeRunId,
		announcement,
		streaming,
		followLatestIfPinned,
	]);
	return <MessageList client={client} streaming={streaming} {...list} />;
}
