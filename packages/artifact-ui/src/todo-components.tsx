import { TodoWorkspace, type TodoWorkspaceProps } from "@eumenes/design-system";
import { useAction } from "./action";
import type { ArtifactRequest } from "./contracts";

export type TodoResource = Omit<
	TodoWorkspaceProps,
	"onView" | "onPage" | "onRefresh" | "onArchive"
> & { kind: "todo-workspace"; revision: number };
export function TodoWorkspaceView({ request }: { request: ArtifactRequest }) {
	const action = useAction(request);
	const data = action.resource;
	if (data?.kind !== "todo-workspace") return null;
	return (
		<TodoWorkspace
			{...data}
			onView={(view) => void action.send("todo-view", { view })}
			onPage={(pageIndex, pageSize) =>
				void action.send("todo-page", {
					pageIndex: String(pageIndex),
					pageSize: String(pageSize),
				})
			}
			onRefresh={() => void action.send("todo-refresh", {})}
			onArchive={(todoId) => void action.send("todo-archive", { todoId })}
		/>
	);
}
