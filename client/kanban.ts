import { z } from "zod";
import type { KanbanNoticeView } from "../api/domains/kanban/contracts";
import { callJson, withQuery, type Transport } from "./transport";

const noticeSchema = z.strictObject({
	id: z.string(),
	kind: z.enum([
		"done",
		"blocker",
		"waiting",
		"commit_push",
		"queue_paused",
		"git_completed",
		"stopped",
	]),
	cardId: z.string().optional(),
	runId: z.string().optional(),
	text: z.string(),
	read: z.boolean(),
	createdAt: z.string(),
}) satisfies z.ZodType<KanbanNoticeView>;

const noticesSchema = z.strictObject({
	notices: z.array(noticeSchema),
	unread: z.number().int().nonnegative(),
});

export function kanbanClient(transport: Transport) {
	return {
		/** Newest first; `unread` counts all unread notices, not only the returned page. */
		kanbanNotices: async (limit = 50, signal?: AbortSignal) =>
			callJson(
				transport,
				noticesSchema,
				withQuery("/api/kanban/notices", { limit }),
				{ signal },
			),
		readKanbanNotice: async (id: string) => {
			await transport.call(
				`/api/kanban/notices/${encodeURIComponent(id)}/read`,
				{ method: "POST" },
			);
		},
	};
}
