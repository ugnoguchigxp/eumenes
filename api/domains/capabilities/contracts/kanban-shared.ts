import { z } from "zod";
import { kanbanAdd, kanbanCardRef, kanbanFollowup } from "./kanban";
const executorId = z
	.string()
	.min(1)
	.max(120)
	.describe(
		"snapshot.executors にある担当のID。利用者が指定した担当を選ぶ。未指定なら snapshot.defaultExecutorId を使ったと伝える。",
	);
export const kanbanSharedAdd = kanbanAdd.extend({ executorId }).strict();
export const kanbanExecutorRef = z.object({ executorId }).strict();
export const kanbanSelectExecutor = kanbanCardRef
	.extend({ executorId })
	.strict();
export const kanbanInspect = z.object({ cardId: z.uuid() }).strict();
export const codexTaskRequest = kanbanAdd;
export const codexTaskRef = kanbanCardRef;
export const codexTaskFollowup = kanbanFollowup;

export const codexTaskConfigure = z
	.object({
		expectedRevision: z.number().int().nonnegative(),
		enabled: z.boolean(),
		runnerId: z.string().nullable(),
		workspaceId: z.string().nullable(),
		resourceId: z.uuid().nullable(),
	})
	.strict();

export const kanbanGitRequest = kanbanCardRef
	.extend({
		sourceRunId: z.uuid().optional(),
		remoteId: z
			.string()
			.regex(/^[a-f0-9]{64}$/)
			.optional(),
		head: z
			.string()
			.regex(/^[a-f0-9]{40,64}$/)
			.optional(),
		snapshotDigest: z
			.string()
			.regex(/^[a-f0-9]{64}$/)
			.optional(),
	})
	.strict();
