import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { EumenesClient } from "../../../../../client";
import { queryRoots } from "../../../queryKeys";

/**
 * Opens the registered screen of a toolchain the conversation agent was asked to do work with: each assignment the
 * agency status lists that started after this page loaded (the user's own request, taken by its toolchain) opens the
 * screen of its adapter once. What started before the page loaded opens nothing, whenever the status is first read.
 * A toolchain with no registered screen opens nothing either (`open` finds none), which is also how Claude Code
 * stays with its own terminals hook.
 */
export function useAssignmentArtifacts(
	client: Pick<EumenesClient, "agencyStatus" | "identity">,
	conversationId: string,
	open: (adapterRef: string, targetRef?: string) => unknown,
) {
	const [loadedAt] = useState(() => Date.now());
	const opened = useRef(new Set<string>());
	const status = useQuery({
		queryKey: [
			queryRoots.dialogue,
			client.identity,
			conversationId,
			"agency-status",
		],
		queryFn: ({ signal }) => client.agencyStatus(conversationId, signal),
		retry: 0,
	});
	const assignments = status.data?.assignments;
	useEffect(() => {
		if (!assignments) return;
		for (const a of assignments) {
			if (opened.current.has(a.assignment)) continue;
			opened.current.add(a.assignment);
			if (a.at < loadedAt) continue;
			open(a.adapterRef, a.targetRef);
		}
	}, [assignments, open, loadedAt]);
}
