import { request } from "node:https";
import type { LookupFunction } from "node:net";
import type { LookupAddress } from "node:dns";
import { timingSafeEqual, randomBytes } from "node:crypto";
import { resolveSafeOutboundUrl } from "llm-fetch";
import { Webhook } from "standardwebhooks";
import type { Subscription, Store } from "./store";

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
export const publicHttpsPost: WebhookPost = async (
	raw,
	body,
	headers,
	signal,
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
	return new Promise((resolve, reject) => {
		const req = request(
			url,
			{
				method: "POST",
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
					if (length > 4096) {
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
export function signedHeaders(
	s: Subscription,
	id: string,
	body: string,
	now = Date.now(),
) {
	const at = new Date(now);
	let signature = new Webhook(s.secret).sign(id, at, body);
	if (s.previous && s.rotateUntil > now)
		signature += " " + new Webhook(s.previous).sign(id, at, body);
	return {
		"Content-Type": "application/json",
		"webhook-id": id,
		"webhook-timestamp": String(Math.floor(now / 1000)),
		"webhook-signature": signature,
		"X-MCP-Subscription-Id": s.id,
	};
}
export async function verifyCallback(s: Subscription, post: WebhookPost) {
	const challenge = randomBytes(32).toString("base64url");
	const body = JSON.stringify({ type: "verification", challenge });
	const reply = await post(
		s.url,
		body,
		signedHeaders(
			s,
			`msg_verification_${randomBytes(16).toString("hex")}`,
			body,
		),
		AbortSignal.timeout(10000),
	);
	if (reply.status < 200 || reply.status >= 300)
		throw new Error("challenge_failed");
	let echoed: unknown;
	try {
		echoed = JSON.parse(reply.body).challenge;
	} catch {
		throw new Error("challenge_failed");
	}
	if (
		typeof echoed !== "string" ||
		Buffer.byteLength(echoed) !== Buffer.byteLength(challenge) ||
		!timingSafeEqual(Buffer.from(echoed), Buffer.from(challenge))
	)
		throw new Error("challenge_failed");
}
export async function deliverNext(
	store: Store,
	post: WebhookPost,
	now = Date.now(),
) {
	const d = store.due();
	if (!d) return false;
	const s = store.subscription(d.subscription);
	store.claim(d.event);
	if (
		!s ||
		!s.active ||
		s.expires <= now ||
		store.get(d.request).state !== "pending"
	) {
		store.delivered(d.event, "stopped", null, "inactive");
		return true;
	}
	let status: number | null = null;
	let retryAfter: string | null = null;
	let reason: string | null = null;
	try {
		const r = await post(
			s.url,
			d.body,
			signedHeaders(s, d.event, d.body, now),
			AbortSignal.timeout(10000),
		);
		status = r.status;
		retryAfter = r.retryAfter;
		reason = `http_${status}`;
	} catch (error) {
		reason =
			error instanceof Error && /timeout|abort/i.test(error.name)
				? "timeout"
				: "network_error";
	}
	const attempts = d.attempts + 1;
	if (status !== null && status >= 200 && status < 300)
		store.delivered(d.event, "accepted", status, null);
	else if (
		attempts < 5 &&
		(status === null || status === 408 || status === 429 || status >= 500)
	) {
		let delay = 1000 * 2 ** (attempts - 1) + Math.floor(Math.random() * 250);
		if (retryAfter) {
			const sec = Number(retryAfter);
			const parsed = Number.isFinite(sec)
				? sec * 1000
				: Date.parse(retryAfter) - now;
			if (Number.isFinite(parsed))
				delay = Math.max(delay, Math.min(30000, Math.max(0, parsed)));
		}
		store.delivered(d.event, "pending", status, reason, now + delay);
	} else store.delivered(d.event, "failed", status, reason);
	return true;
}
