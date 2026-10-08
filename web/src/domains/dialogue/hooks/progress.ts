import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { DialogueClient } from "../../../../../client/dialogue";
import type { RunProgress } from "../../../../../api/domains/dialogue/contracts";
import { invalidateDialogueViews } from "./index";
export function useRunProgress(client: DialogueClient, runId?: string) {
	const [value, setValue] = useState<RunProgress | null>(null);
	const cache = useQueryClient();
	useEffect(() => {
		if (!runId) return;
		const controller = new AbortController();
		void (async () => {
			for (
				let attempt = 0;
				attempt < 5 && !controller.signal.aborted;
				attempt++
			) {
				try {
					await client.watchRun(runId, controller.signal, (next) => {
						if (!controller.signal.aborted) setValue(next);
					});
					invalidateDialogueViews(cache, client.identity, "main");
					return;
				} catch {
					if (controller.signal.aborted) return;
					invalidateDialogueViews(cache, client.identity, "main");
					await new Promise<void>((resolve) => {
						const finish = () => {
							clearTimeout(timer);
							controller.signal.removeEventListener("abort", finish);
							resolve();
						};
						const timer = setTimeout(
							finish,
							Math.min(250 * 2 ** attempt, 3000),
						);
						controller.signal.addEventListener("abort", finish, { once: true });
					});
				}
			}
		})();
		return () => controller.abort();
	}, [client, runId, cache]);
	return value &&
		value.runId === runId &&
		["running", "completed"].includes(value.status)
		? value.text
		: "";
}
