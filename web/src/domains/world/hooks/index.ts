import { useQuery } from "@tanstack/react-query";
import { ApiError, type EumenesClient } from "../../../../../client";
import { queryRoots } from "../../../queryKeys";

type WithIdentity<K extends keyof EumenesClient> = Pick<
	EumenesClient,
	"identity" | K
>;

export const worldKey = (identity: string, ...rest: unknown[]) =>
	[queryRoots.world, identity, ...rest] as const;

/** 404: World is not configured in this run. Anything else is a real failure. */
export const isWorldOff = (error: unknown) =>
	error instanceof ApiError && error.status === 404;

export function useWorldStatus(client: WithIdentity<"worldStatus">) {
	return useQuery({
		queryKey: worldKey(client.identity, "status"),
		queryFn: ({ signal }) => client.worldStatus(signal),
		retry: 0,
	});
}
export function useWorldClaims(
	client: WithIdentity<"worldClaims">,
	scopeKey: string | undefined,
	enabled: boolean,
) {
	return useQuery({
		queryKey: worldKey(client.identity, "claims", scopeKey ?? null),
		queryFn: ({ signal }) => client.worldClaims(scopeKey, signal),
		enabled,
		retry: 0,
	});
}
export function useWorldClaim(
	client: WithIdentity<"worldClaim">,
	scopeKey: string | undefined,
	claimId: string | null,
) {
	return useQuery({
		queryKey: worldKey(client.identity, "claim", scopeKey ?? null, claimId),
		queryFn: ({ signal }) => client.worldClaim(claimId!, scopeKey, signal),
		enabled: claimId !== null,
		retry: 0,
	});
}
export function useWorldForgets(
	client: WithIdentity<"worldForgets">,
	scopeKey: string | undefined,
	enabled: boolean,
) {
	return useQuery({
		queryKey: worldKey(client.identity, "forgets", scopeKey ?? null),
		queryFn: ({ signal }) => client.worldForgets(scopeKey, signal),
		enabled,
		retry: 0,
	});
}
