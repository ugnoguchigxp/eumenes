import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { EumenesClient } from "../../../../../client";
import { queryRoots } from "../../../queryKeys";

type ArchiveClient = Pick<
	EumenesClient,
	| "identity"
	| "archiveTimerNotifications"
	| "archiveKanbanNotices"
	| "archiveTodoNotices"
>;

/** Each source owns its archive. Refresh all sources even when one request fails. */
export function useNotificationArchive(client: ArchiveClient) {
	const cache = useQueryClient();
	const running = useRef(false);
	const [clearing, setClearing] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const clear = async () => {
		if (running.current) return;
		running.current = true;
		setClearing(true);
		setError(null);
		try {
			const results = await Promise.allSettled([
				client.archiveTimerNotifications(),
				client.archiveKanbanNotices(),
				client.archiveTodoNotices(),
			]);
			if (results.some((result) => result.status === "rejected")) {
				setError(
					"一部の通知履歴をクリアできませんでした。もう一度試してください。",
				);
			}
			await Promise.all([
				cache.invalidateQueries({
					queryKey: [queryRoots.timers, "notifications"],
				}),
				cache.invalidateQueries({
					queryKey: [queryRoots.kanban, client.identity, "notices"],
				}),
				cache.invalidateQueries({
					queryKey: [queryRoots.dialogue, client.identity, "todo-notices"],
				}),
			]);
		} finally {
			running.current = false;
			setClearing(false);
		}
	};
	return { clearing, error, clear };
}
