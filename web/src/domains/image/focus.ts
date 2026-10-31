import { focusWhenDrawn } from "../../components/domains/resource-focus";
import { imageContentUrl } from "../../media/use-image-library";

/**
 * The card (or the preview frame) showing this saved image on the open image screen. Parts
 * of the screen that are hidden (the other view) do not count.
 */
function findImageElement(imageId: string): HTMLElement | null {
	const src = imageContentUrl(imageId);
	for (const img of document.querySelectorAll<HTMLImageElement>(
		".image-workspace img",
	)) {
		if (img.getAttribute("src") !== src || img.closest("[hidden]")) continue;
		return (
			img.closest<HTMLElement>(".image-grid-card, .image-preview-frame") ?? img
		);
	}
	return null;
}

/** Marks the image once its element is drawn (the screen may still be rendering); false when it never appears. */
export function focusImageElement(
	imageId: string,
	waitMs = 2_000,
): Promise<boolean> {
	return focusWhenDrawn(() => findImageElement(imageId), waitMs);
}
