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

type Library = Awaited<ReturnType<EumenesClient["imageLibrary"]>>;

/** Shown wherever the saved image list could not be read. */
export const libraryLoadError =
	"保存画像を取得できませんでした。一覧を更新してください。";

/** Newest first, as picker cards; the library has no titles, so date and size name them. */
export const libraryPickerItems = (data: Library | undefined) =>
	(data?.images ?? [])
		.slice()
		.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
		.map((image) => ({
			id: image.id,
			title: `画像 ${image.createdAt.slice(0, 10)}（${image.width}×${image.height}）`,
			thumbnailUrl: imageContentUrl(image.id),
		}));

/** Reconcile a confirmed deletion with the authenticated library shared by all screens. */
export async function deleteLibraryImage(
	cache: QueryClient,
	client: EumenesClient,
	id: string,
) {
	const key = imageLibraryKey(client);
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
