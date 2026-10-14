import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import type { EumenesClient } from "../../../../client";
import { queryRoots } from "../../queryKeys";

type Activity = "working" | "idle" | "waiting" | undefined;

/**
 * Follows the sessions on backend change events: opens the screen when the conversation hands a
 * request over (the request count grows), and sounds a chime when a session finishes its work or
 * starts waiting for the person. What was already so when the page loaded does neither.
 */
export function useClaudeCodeArtifacts(
	client: EumenesClient,
	open: () => void,
	chime: () => void,
) {
	const seen = useRef<number | null>(null);
	const activities = useRef<Map<string, Activity> | null>(null);
	const list = useQuery({
		queryKey: [queryRoots.terminals, client.identity, "requests"],
		queryFn: ({ signal }) => client.terminals(signal),
		retry: false,
	});
	const data = list.data;
	useEffect(() => {
		if (!data) return;
		const before = seen.current;
		seen.current = data.requests;
		if (before !== null && data.requests > before) open();

		const previous = activities.current;
		const next = new Map(
			data.sessions.map((s) => [`${s.id}:${s.run}`, s.activity]),
		);
		activities.current = next;
		if (!previous) return;
		for (const [key, activity] of next) {
			const was = previous.get(key);
			if (
				(was === "working" && activity === "idle") ||
				(activity === "waiting" && was !== "waiting")
			) {
				chime();
				return;
			}
		}
	}, [data, open, chime]);
}
