import { useQuery, type QueryClient } from "@tanstack/react-query";
import type { EumenesClient } from "../../../client";
import { queryRoots } from "../queryKeys";

/** One library cache per authenticated client, shared by viewers and pickers. */
export const imageLibraryKey = (client: Pick<EumenesClient, "identity">) =>
	[queryRoots.image, client.identity, "library"] as const;

export function useImageLibrary(
	client: EumenesClient,
	refetchInterval: number | false = false,
	enabled = true,
) {
	return useQuery({
		queryKey: imageLibraryKey(client),
		queryFn: ({ signal }) => client.imageLibrary(signal),
		enabled,
		refetchInterval,
		retry: false,
	});
}

/** Same-origin content uses the host's existing authentication proxy and browser cache. */
export const imageContentUrl = (id: string) =>
	`/api/images/${encodeURIComponent(id)}/content`;

/** Reconcile a confirmed deletion with the authenticated library shared by all screens. */
export async function deleteLibraryImage(
	cache: QueryClient,
	client: EumenesClient,
	id: string,
) {
	const key = imageLibraryKey(client);
	type Library = Awaited<ReturnType<EumenesClient["imageLibrary"]>>;
	if (
		!cache.getQueryData<Library>(key)?.images.some((image) => image.id === id)
	)
		return false;
	await cache.cancelQueries({ queryKey: key });
	try {
		await client.deleteImage(id);
	} catch {
		await cache.invalidateQueries({ queryKey: key });
		return false;
	}
	await cache.cancelQueries({ queryKey: key });
	cache.setQueryData<Library>(
		key,
		(data) =>
			data && {
				...data,
				images: data.images.filter((image) => image.id !== id),
				totalBytes: Math.max(
					0,
					data.totalBytes -
						(data.images.find((image) => image.id === id)?.bytes ?? 0),
				),
			},
	);
	await cache.invalidateQueries({ queryKey: key });
	return true;
}
