import { systemContext } from "../../../infrastructure/system-context";

/** Shared boundary for delegated tasks; does not import the parent's conversation. */
export const delegatedTaskRules = systemContext(
	"inference.contexts.index.delegated-task-rules",
	{},
);
