import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { DialogueClient } from "../../../../../client/dialogue";
import type { RunProgress } from "../../../../../api/domains/dialogue/contracts";
import { ApiError } from "../../../../../client/transport";
import { invalidateDialogueViews } from "./index";
export function useRunProgress(client: DialogueClient, runId?: string) {
	const [value, setValue] = useState<RunProgress | null>(null);
	const cache = useQueryClient();
	useEffect(() => {
		if (!runId) return;
		const controller = new AbortController();
		void (async () => {
			let attempt = 0;
			let terminal = false;
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
	// A World-using run shows no body until it completes (adoption); the server
	// sends none either, this keeps a stale or foreign frame from showing one.
	return value &&
		value.runId === runId &&
		(value.status === "completed" ||
			(value.status === "running" && !value.worldUsed))
		? value.text
		: "";
}
