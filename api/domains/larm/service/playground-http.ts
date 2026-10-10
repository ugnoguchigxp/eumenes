import { readBounded } from "../../../infrastructure/bounded-read";
import { setTimeout as delay } from "node:timers/promises";
export const pause = (ms: number, signal: AbortSignal) =>
	delay(ms, undefined, { signal });
export const post = (body: unknown): RequestInit => ({
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify(body),
});
export function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("invalid_provider_response");
	return value as Record<string, unknown>;
}
export function str(value: unknown): string {
	if (typeof value !== "string" || !value || value.length > 8192)
		throw new Error("invalid_provider_response");
	return value;
}
export function list(value: unknown): Record<string, unknown>[] {
	if (!Array.isArray(value) || value.length > 512)
		throw new Error("invalid_provider_response");
	return value.map(object);
}
/** `.local` names pass only when listed in `allowLocal` (the LARM base host or an explicit provider host). */
export function localUrl(
	value: string,
	allowLocal: readonly string[] = [],
): URL {
	const u = new URL(value);
	if (
		!["http:", "https:"].includes(u.protocol) ||
		u.username ||
		u.password ||
		u.hash ||
		u.search ||
		!(
			u.hostname === "localhost" ||
			(u.hostname.endsWith(".local") && allowLocal.includes(u.hostname)) ||
			(/^(?:\d{1,3}\.){3}\d{1,3}$/.test(u.hostname) &&
				u.hostname.split(".").every((p) => Number(p) <= 255) &&
				/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(u.hostname))
		)
	)
		throw new Error("invalid_larm_url");
	return u;
}
export function bytes(response: Response, limit: number): Promise<Uint8Array> {
	return readBounded(response.body, {
		limit,
		tooLarge: "response_too_large",
		missing: "invalid_provider_response",
	});
}
export async function json(response: Response) {
	try {
		return object(
			JSON.parse(new TextDecoder().decode(await bytes(response, 2_000_000))),
		);
	} catch {
		throw new Error("invalid_provider_response");
	}
}
export function code(error: unknown): string {
	if (error instanceof DOMException && error.name === "TimeoutError")
		return "deadline_exceeded";
	if (error instanceof TypeError) return "network_unavailable";
	const message = error instanceof Error ? error.message : "provider_failed";
	return /^(larm_http_\d{3}|invalid_[a-z_]+|provider_[a-z_]+|stale_catalog|response_too_large|deadline_exceeded|network_unavailable|generation_unknown|cancel_unconfirmed|result_fetch_failed|larm_unconfigured|larm_base_url_unconfigured|larm_provider_host_mismatch)$/.test(
		message,
	)
		? message
		: "provider_failed";
}
export function silentWav() {
	const b = new Uint8Array(32044);
	const v = new DataView(b.buffer);
	for (const [at, text] of [
		[0, "RIFF"],
		[8, "WAVE"],
		[12, "fmt "],
		[36, "data"],
	] as const)
		b.set(new TextEncoder().encode(text), at);
	v.setUint32(4, b.length - 8, true);
	v.setUint32(16, 16, true);
	v.setUint16(20, 1, true);
	v.setUint16(22, 1, true);
	v.setUint32(24, 16000, true);
	v.setUint32(28, 32000, true);
	v.setUint16(32, 2, true);
	v.setUint16(34, 16, true);
	v.setUint32(40, 32000, true);
	return b;
}
