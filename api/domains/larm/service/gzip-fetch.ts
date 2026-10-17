import type { Fetcher } from "./profiles";

/** Bun owns HTTP compression and response decompression, including SSE streams. */
export function gzipFetch(request: Fetcher): Fetcher {
	return async (input, init = {}) => {
		init.signal?.throwIfAborted();
		const headers = new Headers(init.headers);
		// Byte ranges address the stored media representation, not a gzip variant.
		headers.set("Accept-Encoding", headers.has("Range") ? "identity" : "gzip");
		let body = init.body;
		if (body instanceof FormData && !headers.has("Content-Encoding")) {
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
			compress: body == null ? false : "gzip",
			decompress: true,
		};
		return request(input, options);
	};
}
