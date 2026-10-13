import { TimerWorkspace } from "@eumenes/design-system";
import type { ArtifactRequest } from "./contracts";
import { Feedback, useAction } from "./components";

export function TimerWorkspaceView({ request }: { request: ArtifactRequest }) {
	const action = useAction(request);
	const data = action.resource;
	if (data?.kind !== "timer-workspace") return null;
	const failed = action.status === "rejected" || action.status === "conflict";
	return (
		<>
			<TimerWorkspace
				{...data}
				title={data.title ?? request.title}
				busy={action.pending}
				error={failed ? action.message : undefined}
				onModeChange={(mode) => {
					void action.send("clock-mode", { mode });
				}}
				onStopwatchStart={() => {
					void action.send("stopwatch-start", {});
				}}
				onStopwatchStop={() => {
					void action.send("stopwatch-stop", {});
				}}
				onStopwatchReset={() => {
					void action.send("stopwatch-reset", {});
				}}
				onStart={(draft) => {
					void action.send("timer-start", draft);
				}}
				onCancel={() => {
					void action.send("timer-cancel", {});
				}}
				onPause={() => {
					void action.send("timer-pause", {});
				}}
				onResume={() => {
					void action.send("timer-resume", {});
				}}
				onNew={
					data.canCreate
						? () => {
								void action.send("timer-new", {});
							}
						: undefined
				}
			/>
			{!action.pending &&
				(action.status === "indeterminate" || action.status === "pending") && (
					<Feedback message={action.message} />
				)}
		</>
	);
}
