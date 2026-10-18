export type NavigationCode =
	| "navigation_invalid_url"
	| "navigation_scheme_blocked"
	| "navigation_credentials_blocked"
	| "navigation_private_blocked"
	| "navigation_api_blocked"
	| "navigation_unresolved_blocked";

export type NavigationVerdict =
	| { ok: true; url: string }
	| { ok: false; code: NavigationCode };

const MAX_URL_CHARS = 2048;

function ipv4Octets(host: string) {
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
	return m ? m.slice(1).map(Number) : null;
}
function privateIpv4([a, b]: number[]) {
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 100 && b! >= 64 && b! <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b! >= 16 && b! <= 31) ||
		(a === 192 && b === 168) ||
		(a === 192 && b === 0) ||
		(a === 198 && (b === 18 || b === 19)) ||
		a! >= 224
	);
}
const PRIVATE_SUFFIXES = [
	".localhost",
	".local",
	".internal",
	".lan",
	".home.arpa",
	".localdomain",
];

/**
 * Loopback, private and link-local hosts, including names that only resolve on a local network.
 * The URL parser has already turned numeric spellings (`0x7f.1`, `2130706433`) into dotted form.
 */
export function isPrivateHost(hostname: string) {
	const host = hostname
		.toLowerCase()
		.replace(/^\[|\]$/g, "")
		.replace(/\.$/, "");
	if (host.includes(":")) {
		// Only global unicast (2000::/3) is public; mapped, loopback, unique-local and link-local are not.
		const first = Number.parseInt(host.split(":")[0] || "0", 16);
		return !(first >= 0x2000 && first <= 0x3fff);
	}
	const v4 = ipv4Octets(host);
	if (v4) return privateIpv4(v4);
	if (host === "localhost" || PRIVATE_SUFFIXES.some((s) => host.endsWith(s)))
		return true;
	// A one-label name resolves through the local network's search domain.
	return !host.includes(".");
}

function decoded(path: string) {
	let value = path;
	for (let i = 0; i < 2; i++) {
		try {
			value = decodeURIComponent(value);
		} catch {
			break;
		}
	}
	return value
		.replace(/\\/g, "/")
		.replace(/\/{2,}/g, "/")
		.toLowerCase();
}

export function isWebOrigin(url: URL, webOrigins: readonly string[]) {
	return webOrigins.some((o) => {
		try {
			return new URL(o).origin === url.origin;
		} catch {
			return false;
		}
	});
}

/** A host name that is not an address: only these need a DNS lookup. */
export function isNamedHost(hostname: string) {
	const host = hostname.replace(/^\[|\]$/g, "");
	return !host.includes(":") && !ipv4Octets(host);
}

/**
 * Where a task may send a tab (spec §4.4): http(s) only, no embedded credentials, private addresses only
 * for the Eumenes web origins, and never the API paths the dev proxy answers with the app's own credentials.
 */
export function checkNavigationTarget(
	raw: string,
	webOrigins: readonly string[],
): NavigationVerdict {
	if (raw.length > MAX_URL_CHARS)
		return { ok: false, code: "navigation_invalid_url" };
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return { ok: false, code: "navigation_invalid_url" };
	}
	if (url.protocol !== "http:" && url.protocol !== "https:")
		return { ok: false, code: "navigation_scheme_blocked" };
	if (url.username || url.password)
		return { ok: false, code: "navigation_credentials_blocked" };
	const web = isWebOrigin(url, webOrigins);
	if (isPrivateHost(url.hostname) && !web)
		return { ok: false, code: "navigation_private_blocked" };
	// A prefix match is what a dev proxy applies, so `/apiary` is as unsafe as `/api/x`.
	if (web && decoded(url.pathname).startsWith("/api"))
		return { ok: false, code: "navigation_api_blocked" };
	return { ok: true, url: url.href };
}
