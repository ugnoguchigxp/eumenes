import { TimerWorkspace } from "@eumenes/design-system";
import type { ArtifactRequest } from "./contracts";
import { useAction } from "./components";

export function TimerWorkspaceView({ request }: { request: ArtifactRequest }) {
	const action = useAction(request);
	const data = action.resource;
	if (data?.kind !== "timer-workspace") return null;
	return (
		<TimerWorkspace
			{...data}
			title={data.title ?? request.title}
			busy={action.pending}
			error={action.pending ? undefined : action.message}
			onStart={(draft) => {
				void action.send("timer-start", draft);
			}}
			onCancel={() => {
				void action.send("timer-cancel", {});
			}}
			onNew={
				data.canCreate
					? () => {
							void action.send("timer-new", {});
						}
					: undefined
			}
		/>
	);
}
