import { request } from "node:https";
import {
	LlmFetchError,
	resolveSafeOutboundUrl,
	type SafeHttpFetcher,
} from "llm-fetch";

export function isPublicJsonSource(raw: string) {
	const url = new URL(raw);
	let quotePath = false;
	try {
		const prefix = "/v8/finance/chart/";
		quotePath =
			url.pathname.startsWith(prefix) &&
			/^[A-Z0-9.^-]{1,16}$/.test(
				decodeURIComponent(url.pathname.slice(prefix.length)),
			);
	} catch {
		return false;
	}
	return (
		url.protocol === "https:" &&
		!url.username &&
		!url.password &&
		!url.port &&
		((url.hostname === "www.jma.go.jp" &&
			/^\/bosai\/forecast\/data\/forecast\/\d{6}\.json$/.test(url.pathname) &&
			!url.search) ||
			(url.hostname === "query1.finance.yahoo.com" &&
				quotePath &&
				url.search === "?interval=1d&range=1d"))
	);
}
/** llm-fetch 0.1.2 fixes Accept to text types. These two JSON endpoints require JSON negotiation.
 * Resolve once, pin the public address, retain TLS hostname verification, reject redirects and bound the body.
 * Returned JSON still goes through llm-fetch's unchanged context guard.
 */
export const fetchPublicJson: SafeHttpFetcher = async (raw, input = {}) => {
	if (!isPublicJsonSource(raw))
		throw new LlmFetchError("UNSAFE_URL", "Unsupported public JSON source");
	const signal = AbortSignal.any([
		AbortSignal.timeout(15000),
		...(input.signal ? [input.signal] : []),
	]);
	const resolved = await Promise.race([
		resolveSafeOutboundUrl(raw),
		new Promise<never>((_, reject) => {
			if (signal.aborted) reject(signal.reason);
			else
				signal.addEventListener("abort", () => reject(signal.reason), {
					once: true,
				});
		}),
	]);
	signal.throwIfAborted();
	const address =
		resolved.addresses.find((a) => a.family === 4) ?? resolved.addresses[0]!;
	return new Promise((resolve, reject) => {
		const req = request(
			resolved.url,
			{
				signal,
				agent: false,
				headers: {
					accept: "application/json",
					"accept-encoding": "identity",
					"user-agent": "Eumenes/0.1",
				},
				lookup: (_host, opts, callback) => {
					if (typeof opts === "object" && opts.all)
						(callback as unknown as (e: null, a: (typeof address)[]) => void)(
							null,
							[address],
						);
					else callback(null, address.address, address.family);
				},
			},
			(res) => {
				const status = res.statusCode ?? 0;
				if (
					status !== 200 ||
					(res.headers["content-encoding"] &&
						res.headers["content-encoding"] !== "identity")
				) {
					res.destroy();
					reject(
						new LlmFetchError(
							"UPSTREAM_HTTP",
							"Public JSON response rejected",
							{ status },
						),
					);
					return;
				}
				if (
					res.headers["content-type"]?.split(";", 1)[0]?.trim() !==
					"application/json"
				) {
					res.destroy();
					reject(
						new LlmFetchError(
							"UNSUPPORTED_CONTENT_TYPE",
							"Public source requires JSON",
						),
					);
					return;
				}
				let size = 0;
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => {
					size += chunk.length;
					if (size > 262144)
						res.destroy(
							new LlmFetchError(
								"RESPONSE_TOO_LARGE",
								"Public JSON response exceeded limit",
							),
						);
					else chunks.push(chunk);
				});
				res.on("error", reject);
				res.on("end", () => {
					const headers: Record<string, string> = {};
					for (const [key, value] of Object.entries(res.headers))
						if (typeof value === "string") headers[key] = value;
					resolve({
						requestedUrl: raw,
						finalUrl: raw,
						status,
						contentType: "application/json",
						body: Buffer.concat(chunks),
						headers,
					});
				});
			},
		);
		req.on("error", reject);
		req.end();
	});
};
