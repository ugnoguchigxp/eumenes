import { MusicResultLink } from "../domains/music/MusicResultLink";
import { ImageResultLink } from "../domains/image/ImageResultLink";
import type { WorkspaceState } from "./useWorkspace";
import type { EumenesClient } from "../../../client";
import type { Message } from "../../../api/domains/conversation/contracts";
import type { Run } from "../../../api/domains/dialogue/contracts";
import { ResearchTaskCard } from "../domains/agent-runtime";
import {
	ErrorReportButton,
	RUN_FAILURE_HEADING,
	RunFailureNotice,
} from "./ErrorReportDialog";
import { describeError } from "../errorMessages";

/** The run that answers this input message: an edited message has one run per send, the newest answers it. */
const answeringRun = (message: Pick<Message, "id">, runs: Run[] | undefined) =>
	runs
		?.slice()
		.reverse()
		.find((r) => r.inputMessageId === message.id);

const failureSummary = (
	code: string | null,
	fallback = "応答に失敗しました",
) => (code ? describeError(new Error(code)) : fallback);

/** Persisted notices and delegated work belonging to this input message. */
export function RunDetails({
	client,
	message,
	runs,
	agentName,
}: {
	client: EumenesClient;
	message: Pick<Message, "id" | "text">;
	runs: Run[] | undefined;
	agentName?: string;
}) {
	const run = answeringRun(message, runs);
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
					// A research that failed ends its run as completed, with the host's fixed reply.
					failureAction={
						run.status === "completed"
							? (code) => (
									<ErrorReportButton
										load={(signal) => client.runErrorReport(run.id, signal)}
										heading={RUN_FAILURE_HEADING}
										summary={failureSummary(code)}
									/>
								)
							: undefined
					}
				/>
			)}
			<RunFailure
				client={client}
				message={message}
				runs={runs}
				agentName={agentName}
			/>
		</>
	);
}

/**
 * The failure bubble of the run answering this input message (failed, or interrupted before it answered). It also stands alone for an input the list
 * does not show (a system notice, a request sent from a music or image panel), so every failure is seen.
 */
export function RunFailure({
	client,
	message,
	runs,
	agentName,
}: {
	client: EumenesClient;
	message: Pick<Message, "id">;
	runs: Run[] | undefined;
	agentName?: string;
}) {
	const run = answeringRun(message, runs);
	if (run?.status !== "failed" && run?.status !== "interrupted") return null;
	return (
		<RunFailureNotice
			client={client}
			runId={run.id}
			agentName={agentName}
			summary={
				run.status === "interrupted"
					? failureSummary(run.error, "回答の作成が中断されました")
					: failureSummary(run.error)
			}
		/>
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
