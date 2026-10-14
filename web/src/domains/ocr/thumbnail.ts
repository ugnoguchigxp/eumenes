/** Decode a saved source locally and retain only a small preview in memory. */
export async function ocrThumbnail(source: Blob): Promise<string | null> {
	const sourceUrl = URL.createObjectURL(source);
	const media = source.type.startsWith("video/")
		? document.createElement("video")
		: document.createElement("img");
	try {
		if (media instanceof HTMLVideoElement) {
			media.muted = true;
			media.preload = "auto";
		}
		const loaded = new Promise<void>((resolve, reject) => {
			const timer = window.setTimeout(
				() => reject(new Error("thumbnail_timeout")),
				5000,
			);
			media.addEventListener(
				media instanceof HTMLVideoElement ? "loadeddata" : "load",
				() => {
					window.clearTimeout(timer);
					resolve();
				},
				{ once: true },
			);
			media.addEventListener(
				"error",
				() => {
					window.clearTimeout(timer);
					reject(new Error("thumbnail_decode_failed"));
				},
				{ once: true },
			);
		});
		media.src = sourceUrl;
		await loaded;
		const width =
			media instanceof HTMLVideoElement ? media.videoWidth : media.naturalWidth;
		const height =
			media instanceof HTMLVideoElement
				? media.videoHeight
				: media.naturalHeight;
		if (!width || !height) return null;
		const scale = Math.min(1, 112 / width, 84 / height);
		const canvas = document.createElement("canvas");
		canvas.width = Math.max(1, Math.round(width * scale));
		canvas.height = Math.max(1, Math.round(height * scale));
		canvas
			.getContext("2d")
			?.drawImage(media, 0, 0, canvas.width, canvas.height);
		const thumb = await new Promise<Blob | null>((resolve) =>
			canvas.toBlob(resolve, "image/jpeg", 0.72),
		);
		return thumb ? URL.createObjectURL(thumb) : null;
	} catch {
		return null;
	} finally {
		media.removeAttribute("src");
		if (media instanceof HTMLVideoElement) media.load();
		URL.revokeObjectURL(sourceUrl);
	}
}
