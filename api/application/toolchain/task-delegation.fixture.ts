import { searchThenDelegate } from "./conversation-script.fixture";

/** The dormant task-execution bundle's toolchain: a task execution whose function is `execute_task`. */
export const TASK_TOOLCHAIN = "task.execute";

/**
 * The conversation's usual path to a task execution: search for it, then hand the request over with the announcement
 * (sections 6.1 and 6.5). The run completes with the announcement as its answer; the child reports as notices.
 */
export function handOverTask(
	request: string,
	announcement: string,
	impact: "none" | "create" | "modify_existing" | "irreversible" = "create",
) {
	return searchThenDelegate(
		(candidate) => candidate.id === TASK_TOOLCHAIN,
		request,
		{
			announcement,
			impact,
		},
	);
}
