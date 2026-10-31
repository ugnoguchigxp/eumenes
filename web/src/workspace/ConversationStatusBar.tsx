import type { EumenesClient } from "../../../client";
import { Button } from "../design-system";
import type { useResourceNotice } from "../domains/resources";
import { useBackground, useConversationModel } from "../domains/settings";
import { useSpeechModels } from "../domains/settings/useSpeechModels";
import { describeConnectionState, describeError } from "../errorMessages";
import { BackgroundSelect } from "./BackgroundSelect";
import { ConversationModelSelect } from "./ConversationModelSelect";
import { SpeechModelSelect } from "./SpeechModelSelect";
import type { WorkspaceState } from "./useWorkspace";

/** The addressee, the model and connection controls, and every notice or error shown above the history. */
export function ConversationStatusBar({
	client,
	state,
	resourceNotice,
}: {
	client: EumenesClient;
	state: WorkspaceState;
	resourceNotice: ReturnType<typeof useResourceNotice>;
}) {
	const {
		replay,
		voice,
		phase,
		activeRun,
		connectionState,
		actualModel,
		status,
		connectionError,
		changesState,
		reconnect,
		conversation,
	} = state;
	const model = useConversationModel(client);
	const speechModels = useSpeechModels(client);
	const background = useBackground(client);
	return (
		<>
			<div className="conversation-status" aria-label="接続状態とモデル">
				<span
					className="conversation-addressee"
					data-kind={state.specialist.addressee.kind}
				>
					<span className="conversation-addressee-label">宛先</span>
					<strong>{state.specialist.addressee.label}</strong>
					{state.specialist.addressee.kind === "normal" &&
						state.specialist.addressee.suspended && (
							<span className="conversation-addressee-hold">
								（{state.specialist.addressee.suspended}は一時保留）
							</span>
						)}
				</span>
				<ConversationModelSelect
					model={model}
					running={!!activeRun || speechModels.busy}
					actualModel={actualModel}
				/>
				{state.live?.active ? (
					<>
						<span className="model-select" aria-label="ASR: OFF（Live使用中）">
							ASR: OFF
						</span>
						<span className="model-select" aria-label="TTS: OFF（Live使用中）">
							TTS: OFF
						</span>
					</>
				) : (
					<SpeechModelSelect
						models={speechModels}
						disabled={
							!!activeRun ||
							model.busy ||
							voice.active ||
							phase === "playing" ||
							replay.playingId !== null
						}
					/>
				)}
				<BackgroundSelect background={background} />
				<span
					className="connection-health"
					data-state={connectionState}
					aria-label={`LARMの接続状態: ${describeConnectionState(connectionState)}`}
				>
					<i className="health-dot" aria-hidden="true" />
					<span>LARM</span>
					<span className="health-state">
						{describeConnectionState(connectionState)}
					</span>
				</span>
			</div>
			{state.specialist.notice && (
				<output className="conversation-notice">
					<span>{state.specialist.notice}</span>
					<Button
						variant="ghost"
						size="sm"
						onClick={state.specialist.dismissNotice}
					>
						閉じる
					</Button>
				</output>
			)}
			{resourceNotice.notice && (
				<output className="conversation-notice">
					<span>{resourceNotice.notice}</span>
					<Button variant="ghost" size="sm" onClick={resourceNotice.dismiss}>
						閉じる
					</Button>
				</output>
			)}
			{(model.error || speechModels.error || background.error) && (
				<p className="chat-error" role="alert">
					{model.error || speechModels.error || background.error}
				</p>
			)}
			{status.isError && (
				<p className="chat-error" role="alert">
					ローカル API に接続できません。Eumenes の backend
					と設定を確認してください。
				</p>
			)}
			{connectionError && (
				<p className="chat-error" role="alert">
					LARM に接続できませんでした: {describeError(connectionError)}
				</p>
			)}
			{changesState === "failed" && !status.isError && (
				<p className="chat-error" role="alert">
					更新情報に接続できません。文字起こしや回答の表示が遅れる場合があります。
				</p>
			)}
			{(status.isError ||
				changesState === "failed" ||
				["failed", "unconfigured", "idle"].includes(
					status.data?.larm.state ?? "",
				)) && (
				<Button
					variant="secondary"
					onClick={() => reconnect.mutate()}
					disabled={reconnect.isPending}
				>
					{reconnect.isPending ? "接続を確認中" : "接続を再確認"}
				</Button>
			)}
			{replay.error && (
				<p className="chat-error" role="alert">
					{replay.error}
				</p>
			)}
			{conversation.isError && (
				<p className="chat-error" role="alert">
					会話履歴を取得できませんでした。
				</p>
			)}
		</>
	);
}
