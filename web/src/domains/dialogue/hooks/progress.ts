import { browserTiming } from "../../../performance";
import { useEffect, useState, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { DialogueClient } from "../../../../../client/dialogue";
import type { RunProgress } from "../../../../../api/domains/dialogue/contracts";
import { ApiError } from "../../../../../client/transport";
import { invalidateDialogueViews } from "./index";
export function useRunProgress(client: DialogueClient, runId?: string) {
	const [value, setValue] = useState<RunProgress | null>(null);
	const cache = useQueryClient();
	const timing = useRef<{ id: string; received?: number; committed?: boolean }>(
		{ id: "" },
	);
	useEffect(() => {
		if (
			value?.runId === runId &&
			value?.text &&
			(value.status === "completed" || value.status === "running") &&
			timing.current.id === runId &&
			timing.current.received !== undefined &&
			!timing.current.committed
		) {
			timing.current.committed = true;
			browserTiming("text_committed", { runId }, timing.current.received);
		}
	}, [value, runId]);
	useEffect(() => {
		if (!runId) return;
		timing.current = { id: runId };
		const controller = new AbortController();
		void (async () => {
			let attempt = 0;
			let terminal = false;
			let announcement: string | null = null;
			while (!controller.signal.aborted && !terminal) {
				try {
					await client.watchRun(runId, controller.signal, (next) => {
						if (controller.signal.aborted) return;
						attempt = 0;
						if (
							next.status === "completed" ||
							next.status === "failed" ||
							next.status === "cancelled"
						)
							terminal = true;
						if (
							next.runId === runId &&
							next.text &&
							(next.status === "completed" || next.status === "running") &&
							timing.current.received === undefined
						) {
							timing.current.received = performance.now();
							browserTiming("text_received", { runId });
						}
						if (next.announcement && next.announcement !== announcement) {
							announcement = next.announcement;
							invalidateDialogueViews(cache, client.identity, "main");
						}
						setValue(next);
					});
					invalidateDialogueViews(cache, client.identity, "main");
					return;
				} catch (error) {
					if (controller.signal.aborted) return;
					invalidateDialogueViews(cache, client.identity, "main");
					// The run is gone or access is denied: retrying cannot help.
					if (
						error instanceof ApiError &&
						(error.status === 401 ||
							error.status === 403 ||
							error.status === 404)
					)
						return;
					if (terminal) return;
					await new Promise<void>((resolve) => {
						const finish = () => {
							clearTimeout(timer);
							controller.signal.removeEventListener("abort", finish);
							resolve();
						};
						const timer = setTimeout(
							finish,
							Math.min(250 * 2 ** attempt, 10_000),
						);
						controller.signal.addEventListener("abort", finish, { once: true });
					});
					attempt++;
				}
			}
		})();
		return () => controller.abort();
	}, [client, runId, cache]);
	return value &&
		value.runId === runId &&
		(value.status === "completed" || value.status === "running")
		? value.text
		: "";
}
