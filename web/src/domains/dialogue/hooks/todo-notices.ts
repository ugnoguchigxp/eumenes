import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import type { dialogueClient } from "../../../../../client/dialogue";
import type {
	TodoNotice,
	TodoNotices,
} from "../../../../../api/domains/dialogue/contracts";
import { queryRoots } from "../../../queryKeys";

type NoticeClient = Pick<
	ReturnType<typeof dialogueClient>,
	"identity" | "todoNotices" | "readTodoNotice"
>;

/**
 * Loads the finished TODOs' notices for the notification center (the TODO completion notice design, section 3) and
 * sounds the short tone when new unread ones arrive. Notices already present at the first load do not sound.
 */
export function useTodoNotices(
	client: NoticeClient,
	chime: (
		completed?: boolean,
		notices?: { source: string; ids: readonly string[] },
	) => void,
) {
	const cache = useQueryClient();
	const seen = useRef<Set<string> | null>(null);
	const query = useQuery({
		queryKey: [queryRoots.dialogue, client.identity, "todo-notices"],
		queryFn: ({ signal }) => client.todoNotices(50, signal),
		retry: false,
	});
	const data = query.data;
	useEffect(() => {
		if (!data) return;
		const before = seen.current;
		seen.current = new Set(data.notices.map((notice) => notice.id));
		if (before) {
			const fresh = data.notices.filter((n) => !n.read && !before.has(n.id));
			if (fresh.length)
				chime(
					fresh.some((n) => n.outcome === "succeeded"),
					{
						source: "todo",
						ids: fresh.map((n) => n.id),
					},
				);
		}
	}, [data, chime]);
	const [readError, setReadError] = useState<string | null>(null);
	const markRead = useCallback(
		async (notice: TodoNotice) => {
			const queryKey = [queryRoots.dialogue, client.identity, "todo-notices"];
			// Pressed, it hides at once: the notice reads as read before the server answers; a failure brings it back.
			await cache.cancelQueries({ queryKey });
			cache.setQueryData<TodoNotices>(queryKey, (current) =>
				current
					? {
							unread: Math.max(
								0,
								current.unread -
									(current.notices.some((n) => n.id === notice.id && !n.read)
										? 1
										: 0),
							),
							notices: current.notices.map((n) =>
								n.id === notice.id ? { ...n, read: true } : n,
							),
						}
					: current,
			);
			try {
				await client.readTodoNotice(notice.id);
				setReadError(null);
			} catch {
				setReadError("通知を既読にできませんでした。もう一度試してください。");
			} finally {
				await cache.invalidateQueries({ queryKey });
			}
		},
		[cache, client],
	);
	return {
		notices: data?.notices ?? [],
		unread: data?.unread ?? 0,
		error: readError,
		loadError: query.isError ? "仕事の通知を取得できませんでした。" : null,
		onRead: markRead,
	};
}
