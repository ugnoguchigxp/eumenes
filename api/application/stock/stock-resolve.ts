import { z } from "zod";
import type { ListedCompany } from "./stock-edinet";
import { bestRank, normalizeName, type MatchRank } from "./stock-names";

/** The company the user meant, as the answer will name it. */
export type Resolved = {
	/** The symbol of the chart service ("9434.T", "AAPL"). */
	symbol: string;
	/** The name for the answer, when the resolution knows one (otherwise the chart service's own). */
	name?: string;
	/** The code shown beside the name: the securities code of a Japanese company, else the ticker. */
	code: string;
};

/** One hit of the search service. */
const searchBody = z.object({
	quotes: z
		.array(
			z
				.object({
					symbol: z.string().max(20),
					quoteType: z.string().optional(),
					longname: z.string().optional(),
					shortname: z.string().optional(),
				})
				.passthrough(),
		)
		.max(200),
});
export type SearchHit = {
	symbol: string;
	names: string[];
};

/** The equities and funds of the search service's answer; futures, currencies and the like are not stocks. */
export function parseSearch(body: unknown): SearchHit[] {
	const parsed = searchBody.safeParse(body);
	if (!parsed.success) throw new Error("stock_search_invalid");
	return parsed.data.quotes.flatMap((q) =>
		(q.quoteType === "EQUITY" || q.quoteType === "ETF") && validSymbol(q.symbol)
			? [
					{
						symbol: q.symbol,
						names: [q.longname, q.shortname].flatMap((n) => (n ? [n] : [])),
					},
				]
			: [],
	);
}

/** A symbol that can be put in the chart service's address as it is. */
export const validSymbol = (symbol: string) =>
	/^[A-Za-z0-9.\-^]{1,15}$/.test(symbol);

const japanese = (symbol: string) => /^[0-9]{3}[0-9A-Z]\.T$/.test(symbol);
const codeOf = (symbol: string) =>
	japanese(symbol) ? symbol.slice(0, 4) : symbol;

type Candidate = Resolved & {
	rank: MatchRank;
	japan: boolean;
	capital: number;
	extra: number;
	order: number;
};

/** A securities code typed alone ("9434", "130A", "9434.T"), or undefined. */
export function directCode(query: string) {
	const found = /^([0-9]{3}[0-9A-Z])(?:\.T)?$/.exec(
		query.normalize("NFKC").trim().toUpperCase(),
	);
	return found?.[1];
}

/** Whether the search service takes the query: it refuses anything but plain ASCII text. */
export const searchable = (query: string) =>
	/^[\x20-\x7e]{1,60}$/.test(query.normalize("NFKC"));

/**
 * The one company a query means.
 *
 * Candidates are the listed companies whose name (漢字・英字・ヨミ) fits the query and the search service's
 * hits, joined by symbol. They are ordered by how well the name fits (exact, starts with, contains), then
 * a Japanese listing before any other, then the larger 資本金 (「トヨタ」 is トヨタ自動車, not トヨタ紡織), then
 * the closer length, then the order they were found in. A hit
 * whose symbol is the query itself fits as a name that starts with it.
 */
export function resolveStock(
	query: string,
	companies: readonly ListedCompany[],
	hits: readonly SearchHit[],
): Resolved | undefined {
	const code = directCode(query);
	if (code) {
		const company = companies.find((c) => c.code === code);
		return { symbol: `${code}.T`, name: company?.name, code };
	}
	const wanted = normalizeName(query);
	const typed = query.normalize("NFKC").trim().toUpperCase();
	const found = new Map<string, Candidate>();
	let order = 0;
	const add = (candidate: Omit<Candidate, "order">) => {
		const known = found.get(candidate.symbol);
		if (!known)
			return found.set(candidate.symbol, { ...candidate, order: order++ });
		const better =
			candidate.rank < known.rank ||
			(candidate.rank === known.rank && candidate.extra < known.extra);
		found.set(candidate.symbol, {
			...known,
			// The listed company's own name (and capital) is the one the answer uses.
			name: known.name ?? candidate.name,
			capital: Math.max(known.capital, candidate.capital),
			...(better ? { rank: candidate.rank, extra: candidate.extra } : {}),
		});
	};
	for (const company of companies) {
		const fit = bestRank(wanted, company.keys);
		if (fit)
			add({
				symbol: `${company.code}.T`,
				name: company.name,
				code: company.code,
				japan: true,
				capital: company.capital,
				...fit,
			});
	}
	for (const hit of hits) {
		const fit = bestRank(wanted, hit.names.map(normalizeName));
		const asSymbol = hit.symbol.toUpperCase() === typed;
		const rank = Math.min(fit?.rank ?? 2, asSymbol ? 1 : 2) as MatchRank;
		if (!fit && !asSymbol) continue;
		add({
			symbol: hit.symbol,
			code: codeOf(hit.symbol),
			japan: japanese(hit.symbol),
			capital: 0,
			rank,
			extra: fit?.extra ?? 0,
		});
	}
	const best = [...found.values()].sort(
		(a, b) =>
			a.rank - b.rank ||
			Number(b.japan) - Number(a.japan) ||
			b.capital - a.capital ||
			a.extra - b.extra ||
			a.order - b.order,
	)[0];
	return best && { symbol: best.symbol, name: best.name, code: best.code };
}
