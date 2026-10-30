import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import type { kanbanClient } from "../../../../client/kanban";
import type { KanbanNoticeView } from "../../../../api/domains/kanban/contracts";
import { queryRoots } from "../../queryKeys";

type NoticeClient = { identity: string } & Pick<
	ReturnType<typeof kanbanClient>,
	"kanbanNotices" | "readKanbanNotice"
>;

/**
 * Loads the Kanban notices for the notification center and sounds the short tone when new
 * unread ones arrive. Notices already present at the first load do not sound.
 */
export function useKanbanNotices(
	client: NoticeClient,
	chime: () => void,
	openById: (artifactId: string) => Promise<boolean>,
) {
	const cache = useQueryClient();
	const seen = useRef<Set<string> | null>(null);
	const query = useQuery({
		queryKey: [queryRoots.kanban, client.identity, "notices"],
		queryFn: ({ signal }) => client.kanbanNotices(50, signal),
		retry: false,
	});
	const data = query.data;
	useEffect(() => {
		if (!data) return;
		const before = seen.current;
		seen.current = new Set(data.notices.map((notice) => notice.id));
		if (before && data.notices.some((n) => !n.read && !before.has(n.id)))
			chime();
	}, [data, chime]);
	const [readingIds, setReadingIds] = useState<string[]>([]);
	const [readError, setReadError] = useState<string | null>(null);
	const markRead = useCallback(
		async (notice: KanbanNoticeView) => {
			setReadingIds((ids) => [...ids, notice.id]);
			try {
				await client.readKanbanNotice(notice.id);
				setReadError(null);
			} catch {
				setReadError("通知を既読にできませんでした。もう一度試してください。");
			} finally {
				await cache.invalidateQueries({ queryKey: [queryRoots.kanban] });
				setReadingIds((ids) => ids.filter((id) => id !== notice.id));
			}
		},
		[cache, client],
	);
	const openBoard = useCallback(() => {
		void openById("kanban.board");
	}, [openById]);
	return {
		notices: data?.notices ?? [],
		unread: data?.unread ?? 0,
		readingIds,
		error: readError,
		loadError: query.isError ? "タスクの通知を取得できませんでした。" : null,
		onRead: markRead,
		onOpenBoard: openBoard,
	};
}
