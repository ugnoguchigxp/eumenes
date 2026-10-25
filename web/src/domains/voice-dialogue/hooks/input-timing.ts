import type { SegmentTiming } from "../../audio";

/** Where one voice input's time went before its transcript was shown; numbers only. */
export type InputTiming = Omit<SegmentTiming, "handedAt"> & {
	/** From the segment being handed over to its upload accepted (queue behind earlier uploads, request). */
	uploadMs: number;
	/** From the accepted upload to the transcript on screen (recognition, notification, refetch). */
	uploadToShownMs: number;
};

const KEPT = 16;

/**
 * Per-utterance state of voice inputs on their way to the screen: the clocks from segment to
 * transcript shown (sent once with the commit), and the inputs whose commit is underway.
 */
export function createInputLedger() {
	const uploads = new Map<
		string,
		{ segment: SegmentTiming; uploadMs: number; uploadedAt: number }
	>();
	return {
		committing: new Set<string>(),
		uploaded(id: string, segment: SegmentTiming | undefined) {
			if (!segment) return;
			const uploadedAt = performance.now();
			uploads.set(id, {
				segment,
				uploadMs: Math.round(uploadedAt - segment.handedAt),
				uploadedAt,
			});
			// Inputs that are never shown (empty, cancelled) must not pile up.
			for (const old of uploads.keys()) {
				if (uploads.size <= KEPT) break;
				uploads.delete(old);
			}
		},
		/** The transcript of `id` is on screen: its timing, once. */
		shown(id: string): InputTiming | undefined {
			const upload = uploads.get(id);
			if (!upload) return undefined;
			uploads.delete(id);
			const { handedAt: _, ...segment } = upload.segment;
			return {
				...segment,
				uploadMs: upload.uploadMs,
				uploadToShownMs: Math.round(performance.now() - upload.uploadedAt),
			};
		},
	};
}
export type InputLedger = ReturnType<typeof createInputLedger>;
