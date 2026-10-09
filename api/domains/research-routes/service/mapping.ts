import type { RouteRecipe, SearchSpec } from "../contracts";

const quotePageHosts = new Set(["finance.yahoo.com"]);
const chartHost = "query1.finance.yahoo.com";
const chartPrefix = "/v8/finance/chart/";

const parse = (raw: string): URL | null => {
	try {
		return new URL(raw);
	} catch {
		return null;
	}
};
const decode = (raw: string): string | null => {
	try {
		return decodeURIComponent(raw);
	} catch {
		return null;
	}
};
const plain = (u: URL) =>
	u.protocol === "https:" && !u.username && !u.password && !u.port;

/**
 * Host-fixed mapping between a search hit and the dedicated data API the quote tool reads
 * (plan §6): `finance.yahoo.com/quote/<TICKER>[/...]` ↔ Yahoo chart JSON for the same ticker.
 * Anything not in this table is covered only by exact URL equality, as before.
 */
export function hitCoversSource(
	spec: SearchSpec,
	toolId: RouteRecipe["toolId"],
	hitUrl: string,
	sourceUrl: string,
): boolean {
	if (hitUrl === sourceUrl) return true;
	if (spec.purpose !== "quote" || toolId !== "web.quote") return false;
	const hit = parse(hitUrl);
	const source = parse(sourceUrl);
	if (!hit || !source || !plain(hit) || !plain(source)) return false;
	if (source.hostname !== chartHost || !source.pathname.startsWith(chartPrefix))
		return false;
	const ticker = decode(source.pathname.slice(chartPrefix.length));
	if (ticker !== spec.target.ticker) return false;
	if (!quotePageHosts.has(hit.hostname)) return false;
	const parts = hit.pathname.split("/").filter(Boolean);
	return (
		parts[0] === "quote" &&
		decode(parts[1] ?? "") === spec.target.ticker &&
		parts.length <= 2
	);
}
