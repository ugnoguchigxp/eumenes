import type { Fetcher } from "./profiles";

/** Bun owns HTTP compression and response decompression, including SSE streams. */
export function gzipFetch(request: Fetcher, compressRequest = true): Fetcher {
	return async (input, init = {}) => {
		init.signal?.throwIfAborted();
		const headers = new Headers(init.headers);
		// Byte ranges address the stored media representation, not a gzip variant.
		headers.set("Accept-Encoding", headers.has("Range") ? "identity" : "gzip");
		let body = init.body;
		if (
			compressRequest &&
			body instanceof FormData &&
			!headers.has("Content-Encoding")
		) {
			// Serialize once so the boundary and audio bytes are compressed together.
			const multipart = new Response(body);
			body = await multipart.blob();
			headers.set("Content-Type", body.type);
		}
		init.signal?.throwIfAborted();
		const options = {
			...init,
			headers,
			body,
			compress: compressRequest && body != null ? "gzip" : false,
			decompress: true,
		};
		return request(input, options);
	};
}

/** Small, latency-bound calls (the decision classifiers): neither the request nor the response is compressed. */
export function plainFetch(request: Fetcher): Fetcher {
	return (input, init = {}) => {
		const headers = new Headers(init.headers);
		headers.set("Accept-Encoding", "identity");
		const options = { ...init, headers, compress: false };
		return request(input, options);
	};
}
