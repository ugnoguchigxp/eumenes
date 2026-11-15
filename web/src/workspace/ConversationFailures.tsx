import { useEffect } from "react";
import { ApiError } from "../../../client";
import { describeError, diagnosticErrorCode } from "../errorMessages";
import { FailureNotice } from "./ErrorReportDialog";
import type { WorkspaceState } from "./useWorkspace";

/** Failures outside a failed run still have a report, using the identifiers available to the browser. */
export function ConversationFailures({ state }: { state: WorkspaceState }) {
	const {
		audioError,
		conversation,
		followLatestIfPinned,
		runs,
		settings,
		submit,
		voice,
	} = state;
	const failure = voice.failure;
	const linkedRun = failure?.turn?.runId;
	const reportedByRun =
		linkedRun &&
		runs.data?.some(
			(run) =>
				run.id === linkedRun &&
				(run.status === "failed" || run.status === "interrupted") &&
				conversation.data?.messages.some(
					(message) => message.id === run.inputMessageId,
				),
		);
	const sendFailed = submit.isError;
	const visibleVoiceFailure = !!failure && !reportedByRun;
	useEffect(() => {
		if (sendFailed || visibleVoiceFailure || audioError) followLatestIfPinned();
	}, [
		sendFailed,
		visibleVoiceFailure,
		failure,
		audioError,
		followLatestIfPinned,
	]);
	const agentName = settings.data?.general.agentName;
	return (
		<>
			{sendFailed && (
				<ChatFailure
					heading="送信できませんでした"
					cause={submit.error}
					agentName={agentName}
				/>
			)}
			{visibleVoiceFailure && (
				<ChatFailure
					heading="音声処理に失敗しました"
					cause={failure.cause}
					summary={"summary" in failure ? failure.summary : undefined}
					runId={failure.turn?.runId}
					utteranceId={failure.turn?.utteranceId}
					sessionId={failure.turn?.sessionId}
					agentName={agentName}
				/>
			)}
			{audioError && (
				<ChatFailure
					heading="音声機器でエラーが発生しました"
					cause={audioError}
					agentName={agentName}
				/>
			)}
		</>
	);
}

function ChatFailure({
	heading,
	cause,
	summary = describeError(cause),
	runId,
	utteranceId,
	sessionId,
	agentName,
}: {
	heading: string;
	cause: unknown;
	summary?: string;
	runId?: string | null;
	utteranceId?: string;
	sessionId?: string;
	agentName?: string;
}) {
	const code = diagnosticErrorCode(cause);
	const text = [
		"# Eumenes エラーレポート",
		heading,
		summary,
		code && `エラーコード: ${code}`,
		cause instanceof ApiError && `HTTP: ${cause.status}`,
		cause instanceof ApiError &&
			cause.requestId &&
			/^[\w-]{1,120}$/.test(cause.requestId) &&
			`X-Request-Id: ${cause.requestId}`,
		runId && `runId: ${runId}`,
		utteranceId && `utteranceId: ${utteranceId}`,
		sessionId && `sessionId: ${sessionId}`,
	]
		.filter(Boolean)
		.join("\n");
	return (
		<FailureNotice
			label="会話エラー"
			heading={heading}
			summary={summary}
			agentName={agentName}
			load={async () => ({ text })}
		/>
	);
}
