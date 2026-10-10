import { request } from "node:https";
import type { LookupFunction } from "node:net";
import type { LookupAddress } from "node:dns";
import { resolveSafeOutboundUrl } from "llm-fetch";

export type WebhookPost = (
	url: string,
	body: string,
	headers: Record<string, string>,
	signal: AbortSignal,
) => Promise<{ status: number; body: string; retryAfter: string | null }>;
export function pinnedLookup(address: LookupAddress): LookupFunction {
	return (_hostname, options, callback) => {
		// Node/Bun may ask for all addresses when choosing an IP family.
		if (options.all) callback(null, [address]);
		else callback(null, address.address, address.family);
	};
}
// The shared URL/DNS validator cannot POST. Pin its validated address in the TLS connection.
const safeRequest = async (
	raw: string,
	body: string,
	headers: Record<string, string>,
	signal: AbortSignal,
	method: "GET" | "POST",
	limit: number,
) => {
	const target = new URL(raw);
	if (
		target.protocol !== "https:" ||
		target.username ||
		target.password ||
		target.hash
	)
		throw new Error("invalid_callback_url");
	const { url, addresses } = await new Promise<
		Awaited<ReturnType<typeof resolveSafeOutboundUrl>>
	>((resolve, reject) => {
		const aborted = () => reject(signal.reason);
		if (signal.aborted) {
			aborted();
			return;
		}
		signal.addEventListener("abort", aborted, { once: true });
		resolveSafeOutboundUrl(raw)
			.then(resolve, reject)
			.finally(() => signal.removeEventListener("abort", aborted));
	});
	signal.throwIfAborted();
	const address = addresses[0];
	if (!address) throw new Error("invalid_callback_address");
	return new Promise<{
		status: number;
		body: string;
		retryAfter: string | null;
	}>((resolve, reject) => {
		const req = request(
			url,
			{
				method,
				headers: {
					...headers,
					"Content-Length": String(Buffer.byteLength(body)),
				},
				signal,
				lookup: pinnedLookup(address),
			},
			(res) => {
				const chunks: Buffer[] = [];
				let length = 0;
				res.on("data", (chunk: Buffer) => {
					length += chunk.length;
					if (length > limit) {
						req.destroy(new Error("callback_response_too_large"));
						return;
					}
					chunks.push(chunk);
				});
				res.on("error", reject);
				res.on("end", () =>
					resolve({
						status: res.statusCode ?? 0,
						body: Buffer.concat(chunks).toString(),
						retryAfter:
							typeof res.headers["retry-after"] === "string"
								? res.headers["retry-after"]
								: null,
					}),
				);
			},
		);
		req.on("error", reject);
		req.end(body);
	});
};

export const publicHttpsPost: WebhookPost = (url, body, headers, signal) =>
	safeRequest(url, body, headers, signal, "POST", 4096);
export const publicHttpsGet = (url: string, signal: AbortSignal) =>
	safeRequest(url, "", {}, signal, "GET", 65536);
