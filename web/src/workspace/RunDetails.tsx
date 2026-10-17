import { MusicResultLink } from "../domains/music/MusicResultLink";
import { ImageResultLink } from "../domains/image/ImageResultLink";
import type { WorkspaceState } from "./useWorkspace";
import type { EumenesClient } from "../../../client";
import type { Message } from "../../../api/domains/conversation/contracts";
import type { Run } from "../../../api/domains/dialogue/contracts";
import { ResearchTaskCard } from "../domains/agent-runtime";

/** Persisted notices and delegated work belonging to this input message. */
export function RunDetails({
	client,
	message,
	runs,
}: {
	client: EumenesClient;
	message: Pick<Message, "id" | "text">;
	runs: Run[] | undefined;
}) {
	const run = runs?.find((r) => r.inputMessageId === message.id);
	return (
		<>
			{run?.announcement && (
				<article className="message message-assistant">
					<output aria-live="polite" style={{ whiteSpace: "pre-wrap" }}>
						{run.announcement}
					</output>
				</article>
			)}
			{run?.agentTaskId && (
				<ResearchTaskCard
					client={client}
					rootRunId={run.id}
					title={message.text}
				/>
			)}
		</>
	);
}

/** The saved media attached to an adopted answer. */
export function RunResults({
	runId,
	state,
}: {
	runId: Message["runId"];
	state: Pick<
		WorkspaceState,
		"musicItems" | "openMusic" | "imageItems" | "openImageResult"
	>;
}) {
	return (
		<>
			<MusicResultLink
				runId={runId}
				items={state.musicItems}
				onOpen={state.openMusic}
			/>
			<ImageResultLink
				runId={runId}
				items={state.imageItems}
				onOpen={state.openImageResult}
			/>
		</>
	);
}
