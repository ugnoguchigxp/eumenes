import { useQuery } from "@tanstack/react-query";
import type { EumenesClient } from "../../../client";
import { queryRoots } from "../queryKeys";

/** One library cache per authenticated client, shared by viewers and pickers. */
export const imageLibraryKey = (client: Pick<EumenesClient, "identity">) =>
	[queryRoots.image, client.identity, "library"] as const;

export function useImageLibrary(
	client: EumenesClient,
	refetchInterval: number | false = false,
) {
	return useQuery({
		queryKey: imageLibraryKey(client),
		queryFn: ({ signal }) => client.imageLibrary(signal),
		refetchInterval,
		retry: false,
	});
}

/** Same-origin content uses the host's existing authentication proxy and browser cache. */
export const imageContentUrl = (id: string) =>
	`/api/images/${encodeURIComponent(id)}/content`;
