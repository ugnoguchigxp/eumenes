import type { Run } from "../../../api/domains/dialogue/contracts";
import { Button } from "../design-system";
import type { WorkspaceState } from "./useWorkspace";

/** The answer being made: its stop, and the stop that edits the utterance it answers. */
export function ThinkingRow({
	state,
	run,
}: {
	state: WorkspaceState;
	run: Run;
}) {
	const { cancel, edit, replay } = state;
	return (
		<div className="thinking">
			<span className="thinking-dots" aria-hidden="true">
				<i />
				<i />
				<i />
			</span>
			<output>
				{run.status === "queued" ? "応答を準備中" : "回答を作成中"}
			</output>
			<Button
				variant="ghost"
				size="sm"
				onClick={() => cancel.mutate(run.id)}
				disabled={cancel.isPending}
			>
				中止
			</Button>
			{edit.target?.run.id === run.id && !edit.editing && (
				<Button
					variant="ghost"
					size="sm"
					onClick={() => {
						replay.stop();
						cancel.mutate(run.id);
						edit.start();
					}}
					disabled={cancel.isPending}
				>
					止めて編集
				</Button>
			)}
		</div>
	);
}
