import { setTimeout as delay } from "node:timers/promises";
export const pause = (ms: number, signal: AbortSignal) =>
	delay(ms, undefined, { signal });
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
export function localUrl(value: string): URL {
	const u = new URL(value);
	if (
		!["http:", "https:"].includes(u.protocol) ||
		u.username ||
		u.password ||
		u.hash ||
		u.search ||
		!(
			u.hostname === "localhost" ||
			u.hostname.endsWith(".local") ||
			(/^(?:\d{1,3}\.){3}\d{1,3}$/.test(u.hostname) &&
				u.hostname.split(".").every((p) => Number(p) <= 255) &&
				/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(u.hostname))
		)
	)
		throw new Error("invalid_larm_url");
	return u;
}
export async function bytes(
	response: Response,
	limit: number,
): Promise<Uint8Array> {
	const reader = response.body?.getReader();
	if (!reader) throw new Error("invalid_provider_response");
	const parts: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			size += chunk.value.length;
			if (size > limit) throw new Error("response_too_large");
			parts.push(chunk.value);
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	const result = new Uint8Array(size);
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.length;
	}
	return result;
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
	return /^(larm_http_\d{3}|invalid_[a-z_]+|provider_[a-z_]+|stale_catalog|response_too_large|deadline_exceeded|network_unavailable|generation_unknown|cancel_unconfirmed|result_fetch_failed|larm_unconfigured)$/.test(
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
