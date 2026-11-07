import { prepareImageUpload } from "../../domains/image";
import type { LarmPlayground } from "../../domains/larm";
import type { Model3dSharedImages } from "../../domains/model3d";
import {
	isScratchImage,
	scratchLimits,
	type ScratchStore,
} from "../../domains/scratch";

/** How long one save reads a receipt LARM is still saving (the capture save's budget). */
const POLL_BUDGET_MS = 2 * 60_000;

const pause = (ms: number, signal: AbortSignal) =>
	new Promise<void>((resolve, reject) => {
		const done = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", stop);
			resolve();
		};
		const stop = () => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		const timer = setTimeout(done, ms);
		signal.addEventListener("abort", stop, { once: true });
	});

/**
 * The shared images a 3D generation starts from (spec/server-scratch-cache-design-2026-11-07.md §11.1): held while
 * the generation waits to be sent, then saved into the LARM image library by the existing image import under the
 * generation's id (the same id returns the same saved image).
 */
export function sharedImageImports(
	store: ScratchStore,
	imports: () => LarmPlayground["imageImports"] | null,
): Model3dSharedImages {
	const holds = new Map<string, () => void>();
	const release = (key: string) => {
		holds.get(key)?.();
		holds.delete(key);
	};
	/** A hold no generation let go of (one that ended before its send) ends with the store's lease. */
	const expire = (key: string, held: () => void) =>
		setTimeout(() => {
			if (holds.get(key) === held) release(key);
		}, scratchLimits.leaseMs).unref();
	return {
		hold(id, key) {
			const item = store.get(id);
			if (!item || !isScratchImage(item.mime))
				throw new Error("model3d_image_not_found");
			release(key);
			const held = store.lease(id);
			holds.set(key, held);
			expire(key, held);
		},
		release,
		async artifact(id, key, signal) {
			const item = store.get(id);
			if (!item || !isScratchImage(item.mime))
				throw new Error("model3d_image_not_found");
			const client = imports();
			if (!client) throw new Error("model3d_larm_unconfigured");
			try {
				const prepared = await prepareImageUpload(
					await store.bytes(id),
					item.mime,
					signal,
				);
				let read = await client.send(key, prepared.bytes, signal);
				const until = Date.now() + POLL_BUDGET_MS;
				while (read.receipt.status === "pending" && Date.now() < until) {
					await pause(read.retryAfterMs, signal);
					read = await client.read(key, signal);
				}
				const { receipt } = read;
				if (receipt.status === "succeeded" && !receipt.deleted)
					return receipt.artifact.id;
			} catch (error) {
				// A refusal, an unreadable image or a lost connection: the generation fails, never sent again.
				if (signal.aborted) throw error;
			}
			throw new Error("model3d_source_import_failed");
		},
	};
}
