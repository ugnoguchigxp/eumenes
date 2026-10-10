import { readBounded } from "../../../infrastructure/bounded-read";

export const wait = (ms: number, signal: AbortSignal) =>
	new Promise<void>((resolve, reject) => {
		signal.throwIfAborted();
		const abort = () => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", abort);
			resolve();
		}, ms);
		signal.addEventListener("abort", abort, { once: true });
	});
export async function untilAborted<T>(
	task: Promise<T>,
	signal: AbortSignal,
): Promise<T> {
	signal.throwIfAborted();
	let abort: () => void = () => {};
	try {
		return await Promise.race([
			task,
			new Promise<never>((_, reject) => {
				abort = () => reject(signal.reason);
				signal.addEventListener("abort", abort, { once: true });
			}),
		]);
	} finally {
		signal.removeEventListener("abort", abort);
	}
}
export async function readJson(response: Response): Promise<unknown> {
	const bytes = await readBounded(response.body, {
		limit: 1_000_000,
		tooLarge: "larm_response_too_large",
		missing: "larm_empty_response",
	});
	try {
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		throw new Error("larm_invalid_json");
	}
}
export function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("larm_invalid_contract");
	return value as Record<string, unknown>;
}
export function string(value: unknown): string {
	if (typeof value !== "string" || !value || value.length > 4096)
		throw new Error("larm_invalid_contract");
	return value;
}
/**
 * Accepts loopback / private-LAN URLs. A `.local` name is accepted only when
 * listed in `allowLocal` (the LARM base host itself or an explicit provider host).
 */
export function localEndpoint(
	value: string,
	allowLocal: readonly string[] = [],
): URL {
	const url = new URL(value);
	if (
		!(
			["http:", "https:"].includes(url.protocol) &&
			!url.username &&
			!url.password &&
			!url.search &&
			!url.hash &&
			(url.hostname === "localhost" ||
				(url.hostname.endsWith(".local") &&
					allowLocal.includes(url.hostname)) ||
				(/^(?:\d{1,3}\.){3}\d{1,3}$/.test(url.hostname) &&
					url.hostname.split(".").every((part) => Number(part) <= 255) &&
					/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(
						url.hostname,
					)))
		)
	)
		throw new Error("larm_nonlocal_endpoint");
	return url;
}
/** Parses the comma-separated EUMENES_LARM_PROVIDER_HOSTS value (lower-cased, deduplicated). */
export function parseProviderHosts(raw: string | undefined): string[] {
	return [
		...new Set(
			(raw ?? "")
				.split(",")
				.map((host) => host.trim().toLowerCase())
				.filter(Boolean),
		),
	];
}
/** A provider may receive credentials only at the LARM host or an explicitly listed host. */
export function providerHostAllowed(
	url: URL,
	larmBase: URL,
	extra: readonly string[],
): boolean {
	const host = url.hostname.toLowerCase();
	return host === larmBase.hostname.toLowerCase() || extra.includes(host);
}
/** Provider URL (baseURL / daemonURL) that is local and bound to an allowed host. */
export function providerEndpoint(
	value: string,
	larmBase: URL,
	extra: readonly string[],
): URL {
	const url = localEndpoint(value, [new URL(value).hostname]);
	if (!providerHostAllowed(url, larmBase, extra))
		throw new Error("larm_provider_host_mismatch");
	return url;
}
