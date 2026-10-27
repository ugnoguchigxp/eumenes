import { useState } from "react";
import { Button } from "../Button";
import { taskCancellable, taskStateLabels } from "./labels";
import type { BrowserTaskItem } from "./types";

const operationLabels: Record<string, string> = {
	tab_new: "タブを開く",
	tab_select: "タブを選ぶ",
	tab_close: "タブを閉じる",
	navigate: "ページを開く",
	back: "前のページへ戻る",
	click: "項目を選ぶ",
	type: "入力",
	press: "キー操作",
	select_option: "選択肢を選ぶ",
	scroll: "スクロール",
	wait: "表示を待つ",
};
const operationStates = {
	prepared: "実行待ち",
	dispatched: "実行中",
	observed: "操作成功",
	failed: "実行できませんでした",
	indeterminate: "結果未確認",
};
const phaseLabels = {
	preparing: "Scriptを準備中",
	thinking: "次の行動を検討中",
	connecting: "ブラウザへ接続中",
	observing: "ページを確認中",
	operating: "ブラウザ操作を確認・実行中",
	capturing: "撮影結果を保存中",
};
const stepLabels = {
	pending: "未着手",
	running: "実行中",
	completed: "完了",
	skipped: "変更・省略",
};

export function BrowserScriptPanel({
	tasks,
	pending,
	onCancelTask,
}: {
	tasks: readonly BrowserTaskItem[];
	pending?: boolean;
	onCancelTask: (id: string) => void;
}) {
	const [selected, setSelected] = useState<string>();
	const task = tasks.find((t) => t.taskId === selected) ?? tasks[0];
	if (!task)
		return (
			<p className="browser-workspace-empty">
				チャットでブラウザへの依頼を伝えてください。
			</p>
		);
	const script = task.script;
	return (
		<section className="browser-workspace-section" aria-label="実行Script">
			{tasks.length > 1 && (
				<label>
					表示する作業
					<select
						aria-label="表示する作業"
						value={task.taskId}
						onChange={(e) => setSelected(e.target.value)}
					>
						{tasks.map((t) => (
							<option key={t.taskId} value={t.taskId}>
								{t.requestSummary}
							</option>
						))}
					</select>
				</label>
			)}
			<h3>
				実行Script <span role="status">{taskStateLabels[task.state]}</span>
			</h3>
			{task.state === "running" && task.phase && (
				<p role="status">{phaseLabels[task.phase]}</p>
			)}
			{script ? (
				<>
					{task.history && (
						<p className="browser-script-history-use">
							履歴『{task.history.title}』の手順を使っています
						</p>
					)}
					{script.variables && script.variables.length > 0 && (
						<ul
							className="browser-script-variables"
							aria-label="今回の変数の値"
						>
							{script.variables.map((v) => (
								<li key={v.name}>
									{v.label}: {v.value}
								</li>
							))}
						</ul>
					)}
					<p className="browser-script-summary">{script.summary}</p>
					<ol className="browser-script-steps">
						{script.steps.map((step) => {
							const stopped =
								step.state === "running" &&
								task.state !== "running" &&
								task.state !== "queued";
							return (
								<li
									key={step.stepId}
									data-state={stopped ? task.state : step.state}
								>
									<strong>{step.label}</strong>
									<span>
										{stopped
											? task.state === "completed"
												? "結果未確認"
												: taskStateLabels[task.state]
											: stepLabels[step.state]}
									</span>
									<p>{step.expectation}</p>
								</li>
							);
						})}
					</ol>
					<details>
						<summary>実行履歴</summary>
						{task.operations && (
							<ol>
								{task.operations.map((op) => (
									<li key={op.operationId}>
										<span>
											{op.sequence}.{" "}
											{operationLabels[op.toolKind] ?? "ブラウザ操作"} ·{" "}
											{operationStates[op.state]}
										</span>
										{op.scriptRevision && (
											<small> · Script 版 {op.scriptRevision}</small>
										)}
										{op.errorLabel && <p>{op.errorLabel}</p>}
									</li>
								))}
							</ol>
						)}
						{[...script.history, script].map((rev) => (
							<div key={rev.revision} className="browser-script-history">
								<strong>版 {rev.revision}</strong>
								<p>{rev.change || rev.summary}</p>
								<ul>
									{rev.steps.map((s) => (
										<li key={s.stepId}>
											{s.label} · {stepLabels[s.state]}
										</li>
									))}
								</ul>
							</div>
						))}
					</details>
				</>
			) : (
				<p>
					{taskCancellable(task.state)
						? "実行Scriptを準備しています。"
						: "この作業には保存されたScriptがありません。"}
				</p>
			)}
			{task.resultSummary && <p role="status">{task.resultSummary}</p>}
			{task.errorLabel && <p role="alert">{task.errorLabel}</p>}
			<details>
				<summary>チャットからの依頼</summary>
				<p>{task.requestSummary}</p>
			</details>
			<div className="browser-workspace-actions">
				<span className="browser-workspace-feedback">
					依頼の変更・確認への回答はチャットから
				</span>
				{taskCancellable(task.state) && (
					<Button
						variant="outline"
						size="sm"
						disabled={pending}
						onClick={() => onCancelTask(task.taskId)}
					>
						実行を中止
					</Button>
				)}
			</div>
		</section>
	);
}
