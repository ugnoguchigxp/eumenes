export type BoundedReadOptions = {
	/** Maximum accepted body size in bytes. */
	limit: number;
	/** Error code thrown when the body exceeds `limit`. */
	tooLarge: string;
	/** Error code thrown when there is no body stream. */
	missing: string;
	/** Aborts the read; the stream is cancelled and the abort reason is thrown. */
	signal?: AbortSignal;
};

/**
 * Reads a whole body while enforcing a byte limit. On any failure the stream is
 * cancelled and the lock released, so an oversized or stalled peer cannot keep
 * the connection open.
 */
export async function readBounded(
	body: ReadableStream<Uint8Array> | null | undefined,
	options: BoundedReadOptions,
): Promise<Uint8Array> {
	if (!body) throw new Error(options.missing);
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	const abort = () => {
		void reader.cancel().catch(() => {});
	};
	options.signal?.addEventListener("abort", abort, { once: true });
	try {
		for (;;) {
			options.signal?.throwIfAborted();
			const { value, done } = await reader.read();
			options.signal?.throwIfAborted();
			if (done) break;
			size += value.byteLength;
			if (size > options.limit) throw new Error(options.tooLarge);
			chunks.push(value);
		}
	} catch (error) {
		await reader.cancel().catch(() => {});
		throw error;
	} finally {
		options.signal?.removeEventListener("abort", abort);
		reader.releaseLock();
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}
