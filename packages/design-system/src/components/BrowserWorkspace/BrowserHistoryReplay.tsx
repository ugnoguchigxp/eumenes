import { useId, useState } from "react";
import { Button } from "../Button";
import { Input } from "../Input";
import { Modal } from "../Modal";
import { replayLabels } from "./labels";
import type { BrowserHistoryDetail, BrowserReplayItem } from "./types";

const VALUE_MAX_LENGTH = 200;

export type BrowserHistoryReplayProps = {
	detail: BrowserHistoryDetail;
	/** この履歴の最新のリプレイ。 */
	replay?: BrowserReplayItem;
	pending?: boolean;
	onReplay: (
		historyId: string,
		expectedRevision: number,
		values: Record<string, string>,
	) => void;
	onCancel: (replayId: string) => void;
};

/** 終わったリプレイの一行。実行中なら undefined。 */
export function replayStatusLine(replay: BrowserReplayItem) {
	if (replay.state === "completed") return replayLabels.completed;
	if (replay.state === "cancelled") return replayLabels.cancelled;
	if (replay.state === "failed")
		return replay.errorLabel ?? replayLabels.failed;
	return undefined;
}

/**
 * 履歴のコードを新しいタブで実行する区画。変数があれば値を入れ、押すと実行するコードを確認に出す。
 * 実行の状態は最新のリプレイから表示し、実行中は中止できる。
 */
export function BrowserHistoryReplay({
	detail,
	replay,
	pending,
	onReplay,
	onCancel,
}: BrowserHistoryReplayProps) {
	const id = useId();
	const [values, setValues] = useState<Record<string, string>>({});
	const [confirming, setConfirming] = useState(false);
	const running = replay?.state === "running";
	const plan = detail.replay;
	const blockedLine = plan
		? plan.blocked !== null
			? (plan.blockedLabel ?? replayLabels.blockedFallback)
			: undefined
		: replayLabels.unavailable;
	const locked = running || blockedLine !== undefined;
	const filled = detail.variables.every(
		(v) => (values[v.name] ?? "").trim() !== "",
	);
	const ended = replay && !running ? replayStatusLine(replay) : undefined;
	return (
		<section aria-label="リプレイ">
			<h4>{replayLabels.button}</h4>
			{detail.variables.map((v) => (
				<div key={v.name} className="browser-history-replay-field">
					<label htmlFor={`${id}-${v.name}`}>{v.label}</label>
					<Input
						id={`${id}-${v.name}`}
						type="text"
						required
						maxLength={VALUE_MAX_LENGTH}
						value={values[v.name] ?? ""}
						disabled={locked}
						onChange={(e) =>
							setValues((previous) => ({
								...previous,
								[v.name]: e.target.value,
							}))
						}
					/>
				</div>
			))}
			<div className="browser-workspace-actions">
				<Button
					type="button"
					variant="outline"
					disabled={!filled || locked || pending}
					onClick={() => setConfirming(true)}
				>
					{replayLabels.button}
				</Button>
				{blockedLine && (
					<output aria-live="polite" className="browser-history-replay-status">
						{blockedLine}
					</output>
				)}
				{running && replay && (
					<>
						<output aria-live="polite">{replayLabels.running}</output>
						<Button
							type="button"
							variant="outline"
							disabled={pending}
							onClick={() => onCancel(replay.replayId)}
						>
							{replayLabels.cancel}
						</Button>
					</>
				)}
				{ended && (
					<output
						aria-live="polite"
						data-state={replay?.state}
						className="browser-history-replay-status"
					>
						{ended}
					</output>
				)}
			</div>
			<Modal
				open={confirming && plan !== undefined}
				onOpenChange={setConfirming}
				title={replayLabels.confirmTitle}
				draggable={false}
				footer={
					<>
						<Button
							type="button"
							variant="outline"
							onClick={() => setConfirming(false)}
						>
							{replayLabels.abort}
						</Button>
						<Button
							type="button"
							onClick={() => {
								setConfirming(false);
								onReplay(
									detail.historyId,
									detail.revision,
									Object.fromEntries(
										detail.variables.map((v) => [v.name, values[v.name] ?? ""]),
									),
								);
							}}
						>
							{replayLabels.run}
						</Button>
					</>
				}
			>
				<div className="browser-history-detail">
					<p>{replayLabels.confirmNote}</p>
					{detail.hasCommit && (
						<p className="browser-history-replay-commit" role="note">
							{replayLabels.commitNote}
						</p>
					)}
					{detail.variables.length > 0 && (
						<ul aria-label="変数の値">
							{detail.variables.map((v) => (
								<li key={v.name}>
									変数: {v.label} = {values[v.name] ?? ""}
								</li>
							))}
						</ul>
					)}
					<h5>{replayLabels.codeHeading}</h5>
					<pre className="browser-history-source">
						<code>{plan?.code}</code>
					</pre>
				</div>
			</Modal>
		</section>
	);
}
