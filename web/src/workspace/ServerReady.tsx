import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import type { EumenesClient } from "../../../client";
import { queryRoots } from "../queryKeys";

/** How often a starting server is asked again. */
const STARTING_POLL_MS = 1000;

/**
 * Holds the workspace until the server's services are up (spec server-listen-first-startup 2026-11-07 §6): while
 * `/api/status` says `starting` every other request is refused with 503, so the workspace would only fail. It shares
 * the status query of the workspace and asks again only while the last answer was `starting`; an unreachable server
 * is left to the workspace's own connection display. Once shown, the workspace stays: a later restart of the server
 * must not discard its state.
 */
export function ServerReady({
	client,
	children,
}: {
	client: EumenesClient;
	children: ReactNode;
}) {
	const status = useQuery({
		queryKey: [queryRoots.larm, client.identity],
		queryFn: () => client.status(),
		retry: 0,
		refetchInterval: (query) =>
			query.state.data?.phase === "starting" ? STARTING_POLL_MS : false,
	});
	const reached = status.data?.phase === "ready" || status.isError;
	// Latched while rendering (React's "adjusting state when a prop changes"), so no extra effect pass.
	const [shown, setShown] = useState(false);
	if (reached && !shown) setShown(true);
	if (shown || reached) return children;
	return (
		<main>
			<output aria-live="polite">サーバー起動中です。</output>
		</main>
	);
}
