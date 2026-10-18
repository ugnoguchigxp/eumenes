import type { DriverTab } from "../contracts/ports";
import type { Ctx } from "./context";
import {
	checkNavigationTarget,
	isNamedHost,
	isPrivateHost,
	isWebOrigin,
	type NavigationVerdict,
} from "./navigation";

const DNS_TTL_MS = 15_000;
const DNS_TIMEOUT_MS = 3_000;
const DNS_CACHE_MAX = 500;

/** Addresses of a host name, or null when it does not resolve in time. Short-lived cache: a tab list asks for every tab. */
async function addressesOf(ctx: Ctx, hostname: string) {
	const hit = ctx.dnsCache.get(hostname);
	if (hit && hit.at > ctx.now() - DNS_TTL_MS) return hit.addresses;
	let addresses: string[] | null = null;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		addresses = await Promise.race([
			ctx.resolveHost(hostname),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("dns_timeout")),
					DNS_TIMEOUT_MS,
				);
			}),
		]);
	} catch {
		addresses = null;
	} finally {
		clearTimeout(timer);
	}
	if (ctx.dnsCache.size >= DNS_CACHE_MAX) ctx.dnsCache.clear();
	ctx.dnsCache.set(hostname, { at: ctx.now(), addresses });
	return addresses;
}

/**
 * The destination check (spec §4.4) for a URL the host is about to send a tab to or has seen a tab at:
 * the static rules, then the addresses the name resolves to. A name that resolves to a loopback, private or
 * link-local address is private, whatever it looks like; only the Eumenes web origins may be. Runs outside
 * writer transactions (it may wait for DNS). A name that does not resolve is refused: the browser may
 * resolve it differently than this process does.
 */
export async function urlVerdict(
	ctx: Ctx,
	raw: string,
): Promise<NavigationVerdict> {
	const verdict = checkNavigationTarget(raw, ctx.webOrigins);
	if (!verdict.ok) return verdict;
	const url = new URL(verdict.url);
	if (isWebOrigin(url, ctx.webOrigins) || !isNamedHost(url.hostname))
		return verdict;
	const addresses = await addressesOf(ctx, url.hostname);
	if (!addresses || addresses.length === 0)
		return { ok: false, code: "navigation_unresolved_blocked" };
	if (addresses.some((a) => isPrivateHost(a)))
		return { ok: false, code: "navigation_private_blocked" };
	return verdict;
}

/** Tab-list entries the host must not adopt, by MCP index → the code that explains it. */
export async function blockedEntries(
	ctx: Ctx,
	list: readonly DriverTab[],
): Promise<ReadonlyMap<number, string>> {
	const blocked = new Map<number, string>();
	await Promise.all(
		list.map(async (entry) => {
			const verdict = await urlVerdict(ctx, entry.url);
			if (!verdict.ok) blocked.set(entry.index, verdict.code);
		}),
	);
	return blocked;
}
