import { useRef } from "react";
import {
	type QueryClient,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import type {
	SpecialistCommandKind,
	SpecialistSession,
} from "../../../../../api/domains/dialogue/contracts";
import type { DialogueClient } from "../../../../../client/dialogue";
import { queryRoots } from "../../../queryKeys";

/** The session is polled modestly while one is live; run changes invalidate it sooner. */
const sessionPollMs = 5_000;

const specialistKey = (identity: string, conversationId: string) =>
	[queryRoots.dialogue, identity, conversationId, "specialist"] as const;

export function invalidateSpecialistSession(
	cache: QueryClient,
	identity: string,
	conversationId: string,
) {
	return cache.invalidateQueries({
		queryKey: specialistKey(identity, conversationId),
	});
}

/** The conversation's live (non-ended) specialist session, or null. */
export function useSpecialistSession(
	client: DialogueClient,
	conversationId: string,
) {
	return useQuery({
		queryKey: specialistKey(client.identity, conversationId),
		queryFn: async (): Promise<SpecialistSession | null> =>
			(await client.specialistSession(conversationId)).session,
		refetchInterval: (query) => (query.state.data ? sessionPollMs : false),
		staleTime: 500,
		retry: 0,
	});
}

export type SpecialistCommandInput = {
	session: Pick<SpecialistSession, "id" | "revision">;
	kind: SpecialistCommandKind;
};

/**
 * Return, resume, discard or close the session from the screen. A repeated attempt of the same
 * command on the same session revision reuses its request id, so an unanswered request is
 * not run twice.
 */
export function useSpecialistCommand(
	client: DialogueClient,
	conversationId: string,
) {
	const cache = useQueryClient();
	const sent = useRef(new Map<string, string>());
	return useMutation({
		mutationFn: async ({ session, kind }: SpecialistCommandInput) => {
			const key = `${session.id}:${session.revision}:${kind}`;
			const requestId = sent.current.get(key) ?? crypto.randomUUID();
			sent.current.set(key, requestId);
			return client.specialistCommand(session.id, kind, {
				requestId,
				expectedRevision: session.revision,
			});
		},
		retry: false,
		onSettled: () =>
			invalidateSpecialistSession(cache, client.identity, conversationId),
	});
}
