import {
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useRef } from "react";
import type { ContinuityClient } from "../../../../../client/continuity";
import { ApiError } from "../../../../../client/transport";
import type {
	CreateBookmarkRequest,
	DeactivateBookmarkRequest,
	ReviseBookmarkRequest,
} from "../../../../../api/domains/continuity/contracts";

export const continuityKey = (identity: string, conversationId: string) =>
	["continuity", identity, conversationId] as const;

export function useBookmarks(
	client: ContinuityClient,
	conversationId: string,
	includeInactive = false,
) {
	return useQuery({
		queryKey: [
			...continuityKey(client.identity, conversationId),
			"list",
			includeInactive,
		],
		queryFn: ({ signal }) =>
			client.list(conversationId, { includeInactive }, signal),
		retry: 1,
	});
}

export function useBookmarkHistory(
	client: ContinuityClient,
	conversationId: string,
	bookmarkId: string,
	options: { enabled?: boolean; limit?: number } = {},
) {
	return useInfiniteQuery({
		queryKey: [
			...continuityKey(client.identity, conversationId),
			"history",
			bookmarkId,
			options.limit ?? null,
		],
		queryFn: ({ pageParam, signal }) =>
			client.history(
				conversationId,
				bookmarkId,
				{ after: pageParam, limit: options.limit },
				signal,
			),
		initialPageParam: undefined as number | undefined,
		getNextPageParam: (last) => last.nextCursor ?? undefined,
		enabled: options.enabled ?? true,
		retry: 1,
	});
}

export function useBookmarkSource(
	client: ContinuityClient,
	conversationId: string,
	bookmarkId: string,
	options: { enabled?: boolean } = {},
) {
	return useQuery({
		queryKey: [
			...continuityKey(client.identity, conversationId),
			"source",
			bookmarkId,
		],
		queryFn: ({ signal }) => client.source(conversationId, bookmarkId, signal),
		enabled: options.enabled ?? true,
		retry: 1,
	});
}

/** Reload every continuity query of the conversation after a write, and also after a conflict so the user sees the latest state. */
function useRefetchAfterWrite(
	client: ContinuityClient,
	conversationId: string,
) {
	const queries = useQueryClient();
	const refetch = () =>
		queries.invalidateQueries({
			queryKey: continuityKey(client.identity, conversationId),
		});
	return {
		onSuccess: refetch,
		onError: (error: unknown) =>
			error instanceof ApiError && error.status === 409 ? refetch() : undefined,
	};
}

export function useCreateBookmark(
	client: ContinuityClient,
	conversationId: string,
) {
	return useMutation({
		mutationFn: (request: CreateBookmarkRequest) =>
			client.create(conversationId, request),
		...useRefetchAfterWrite(client, conversationId),
	});
}

export function useReviseBookmark(
	client: ContinuityClient,
	conversationId: string,
	bookmarkId: string,
) {
	return useMutation({
		mutationFn: (request: ReviseBookmarkRequest) =>
			client.revise(conversationId, bookmarkId, request),
		...useRefetchAfterWrite(client, conversationId),
	});
}

export function useDeactivateBookmark(
	client: ContinuityClient,
	conversationId: string,
	bookmarkId: string,
) {
	return useMutation({
		mutationFn: (request: DeactivateBookmarkRequest) =>
			client.deactivate(conversationId, bookmarkId, request),
		...useRefetchAfterWrite(client, conversationId),
	});
}

/**
 * One requestId per user operation: the same payload (retry) keeps the id,
 * a different payload or a finished operation gets a new one.
 */
export function useOperationRequestId() {
	const current = useRef<{ payload: string; id: string } | null>(null);
	return {
		idFor(payload: unknown): string {
			const key = JSON.stringify(payload);
			if (current.current?.payload !== key)
				current.current = { payload: key, id: crypto.randomUUID() };
			return current.current.id;
		},
		reset() {
			current.current = null;
		},
	};
}
