import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import {
	SCREEN_COMMAND_TTL_MS,
	type ScreenCommand,
} from "../../../../api/domains/resources/contracts";
import type { EumenesClient } from "../../../../client";
import { queryRoots } from "../../queryKeys";
import { resourcesApiFor } from "./api";
import { presentOnScreen, type ResourceLauncher } from "./present";
import { BLOCKED_NOTICE } from "./use-resource-opener";

/** The last command seq seen per conversation, kept in memory so a command is never run twice. */
const lastSeen = new Map<string, number>();
const seenKey = (client: EumenesClient, conversationId: string) =>
	`${client.identity}|${conversationId}`;

/** Forgets the seen seqs; for tests. */
export function resetScreenCommandMemory() {
	lastSeen.clear();
}

const POLL_MS = 2_000;

/**
 * Runs the screen commands the conversation issues (open a resource, play it) and reports each
 * to the backend: `done`, `blocked` (the browser refused to play without a gesture) or
 * `unavailable` (no screen or item for it). Commands run one at a time, in seq order.
 */
export function useScreenCommands({
	client,
	conversationId,
	launcher,
	notify,
}: {
	client: EumenesClient;
	conversationId: string;
	launcher: ResourceLauncher;
	notify: (message: string) => void;
}) {
	const key = seenKey(client, conversationId);
	const query = useQuery({
		queryKey: [queryRoots.screen, client.identity, conversationId, "commands"],
		queryFn: ({ signal }) =>
			resourcesApiFor(client).screenCommands(
				conversationId,
				lastSeen.get(key) ?? 0,
				signal,
			),
		refetchInterval: POLL_MS,
		retry: false,
	});
	const latest = useRef({ launcher, notify });
	useEffect(() => {
		latest.current = { launcher, notify };
	});
	const queue = useRef<Promise<void>>(Promise.resolve());
	const commands = query.data?.commands;
	useEffect(() => {
		if (!commands) return;
		const fresh = commands
			.filter((c) => c.status === "pending" && c.seq > (lastSeen.get(key) ?? 0))
			.sort((a, b) => a.seq - b.seq);
		for (const command of fresh) {
			// Claimed here, before it runs, so a later poll cannot hand it out again.
			lastSeen.set(key, command.seq);
			queue.current = queue.current.then(() =>
				run(client, command, latest.current),
			);
		}
	}, [commands, client, key]);
}

async function run(
	client: EumenesClient,
	command: ScreenCommand,
	{
		launcher,
		notify,
	}: { launcher: ResourceLauncher; notify: (message: string) => void },
) {
	// The backend has already given up on a command nobody received in time.
	if (Date.now() - Date.parse(command.createdAt) > SCREEN_COMMAND_TTL_MS)
		return;
	const outcome = await presentOnScreen(launcher, {
		adapterRef: command.adapterRef,
		targetRef: command.targetRef,
		action: command.action,
	});
	if (outcome === "blocked") notify(BLOCKED_NOTICE);
	// A receipt that cannot be sent leaves the command to expire on the backend.
	await resourcesApiFor(client)
		.screenReceipt(command.seq, { outcome })
		.catch(() => undefined);
}
