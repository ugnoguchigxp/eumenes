import { lookup } from "node:dns/promises";
import { isIPv4 } from "node:net";
import os from "node:os";

type Interfaces = () => { address: string; netmask: string }[];
const LOOKUP_MS = 1000;

const toNumber = (ip: string) =>
	ip.split(".").reduce((n, part) => (n << 8) | Number(part), 0) >>> 0;
const inRange = (ip: number, base: string, bits: number) =>
	bits === 0 || ip >>> (32 - bits) === toNumber(base) >>> (32 - bits);
const privateRanges: [string, number][] = [
	["10.0.0.0", 8],
	["172.16.0.0", 12],
	["192.168.0.0", 16],
	["169.254.0.0", 16],
];

function hostInterfaces() {
	return Object.values(os.networkInterfaces()).flatMap((list) =>
		(list ?? []).filter((i) => i.family === "IPv4" && !i.internal),
	);
}

async function resolve(host: string) {
	if (isIPv4(host)) return host;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const found = await Promise.race([
			lookup(host, { family: 4 }),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("lookup_timeout")),
					LOOKUP_MS,
				);
			}),
		]);
		return found.address;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Whether LARM is expected to answer from here (spec §12). A private LARM address counts only
 * when it shares a subnet with this host; a public one always does; an unresolvable one does not.
 * Without a saved LARM there is nothing to place, so the caller keeps its disconnection.
 */
export function createLanPresence(
	baseUrl: () => string | null | undefined,
	interfaces: Interfaces = hostInterfaces,
) {
	return async function present() {
		const url = baseUrl();
		if (!url) return true;
		let host: string;
		try {
			host = new URL(url).hostname.replace(/^\[|\]$/g, "");
		} catch {
			return true;
		}
		if (host.includes(":")) return true;
		const address = await resolve(host);
		if (!address) return false;
		const ip = toNumber(address);
		if (!privateRanges.some(([base, bits]) => inRange(ip, base, bits)))
			return true;
		return interfaces().some((i) => {
			const mask = toNumber(i.netmask);
			return (toNumber(i.address) & mask) >>> 0 === (ip & mask) >>> 0;
		});
	};
}
