import { useEffect, useState } from "react";
import type { EumenesClient } from "../../../../client";

/** Loads the selected track's completed artwork through the authenticated API as a Blob URL. */
export function useMusicArtworkUrl(
	client: EumenesClient,
	id: string | undefined,
	revision: number | undefined,
) {
	const [artwork, setArtwork] = useState<{
		id: string;
		revision: number;
		url?: string;
		failed?: boolean;
	}>();
	useEffect(() => {
		if (!id || revision === undefined) return;
		const controller = new AbortController();
		let url: string | undefined;
		void client
			.musicArtwork(id, controller.signal)
			.then((blob) => {
				if (controller.signal.aborted) return;
				url = URL.createObjectURL(blob);
				setArtwork({ id, revision, url });
			})
			.catch(() => {
				if (!controller.signal.aborted)
					setArtwork({ id, revision, failed: true });
			});
		return () => {
			controller.abort();
			// Never hand back a revoked URL when the same track is selected again.
			setArtwork(undefined);
			if (url) URL.revokeObjectURL(url);
		};
	}, [client, id, revision]);
	return artwork && artwork.id === id && artwork.revision === revision
		? artwork
		: undefined;
}
