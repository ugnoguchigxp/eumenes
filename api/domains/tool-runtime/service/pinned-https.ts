import { request } from "node:https";
import type { LookupFunction } from "node:net";
import { Readable } from "node:stream";
import type { ResolvedAddress } from "llm-fetch";

/** Connects to the already validated address, whatever DNS says at connect time. */
function pinnedLookup(address: ResolvedAddress): LookupFunction {
	return (_hostname, options, callback) => {
		// Node/Bun may ask for all addresses when choosing an IP family.
		if (options.all) callback(null, [address]);
		else callback(null, address.address, address.family);
	};
}

const NO_BODY_STATUS = new Set([204, 205, 304]);

/**
 * `fetch`-shaped HTTPS request whose TCP connection goes to `address`. TLS still verifies the
 * URL's hostname (SNI and certificate), and redirects are returned to the caller, never followed.
 */
export function pinnedHttpsFetch(
	url: URL,
	init: {
		method: string;
		headers: Record<string, string>;
		body?: string;
		signal: AbortSignal;
	},
	address: ResolvedAddress,
): Promise<Response> {
	return new Promise((resolve, reject) => {
		const headers = { ...init.headers };
		if (init.body !== undefined)
			headers["content-length"] = String(Buffer.byteLength(init.body));
		const req = request(
			url,
			{
				method: init.method,
				headers,
				signal: init.signal,
				lookup: pinnedLookup(address),
			},
			(res) => {
				const responseHeaders = new Headers();
				for (const [name, value] of Object.entries(res.headers))
					for (const item of Array.isArray(value) ? value : [value])
						if (item !== undefined) responseHeaders.append(name, item);
				const status = res.statusCode ?? 0;
				resolve(
					new Response(
						NO_BODY_STATUS.has(status)
							? null
							: (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>),
						{ status, headers: responseHeaders },
					),
				);
			},
		);
		req.on("error", reject);
		req.end(init.body);
	});
}
