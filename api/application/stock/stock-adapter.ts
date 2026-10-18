import { stockQuote } from "../../domains/capabilities";
import type { DomainAdapter, InstantResult } from "../../domains/tool-runtime";
import { readBounded } from "../../infrastructure/bounded-read";
import { getLogger } from "../../infrastructure/logger";
import { parseCompanies, unzipCsv, type ListedCompany } from "./stock-edinet";
import { parseChart, quoteSentence } from "./stock-quote";
import {
	directCode,
	parseSearch,
	resolveStock,
	searchable,
	validSymbol,
	type Resolved,
	type SearchHit,
} from "./stock-resolve";

export const STOCK_ADAPTER_REF = "adapter:stock@1";
const QUOTE = "stock.quote";
const INPUT_SCHEMA = "builtin:stockQuote";

const log = getLogger("stock");

/** The three services read. Their addresses are fixed here; the symbol and the query are encoded into them. */
const CODE_LIST_URL =
	"https://disclosure2dl.edinet-fsa.go.jp/searchdocument/codelist/Edinetcode.zip";
const SEARCH_URL = "https://query1.finance.yahoo.com/v1/finance/search";
const CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart";

const CODE_LIST_LIMIT_BYTES = 4 * 1024 * 1024;
const SEARCH_LIMIT_BYTES = 512 * 1024;
const CHART_LIMIT_BYTES = 512 * 1024;
const CODE_LIST_TIMEOUT_MS = 20_000;
const SEARCH_TIMEOUT_MS = 6_000;
const CHART_TIMEOUT_MS = 8_000;
/** The list changes slowly; it is read again once a day, and a failed read is retried after a minute. */
const CODE_LIST_TTL_MS = 24 * 3_600_000;
const CODE_LIST_RETRY_MS = 60_000;

/** What the adapter offers a bundle check without a running service. */
export const describeStockAdapter = () => ({
	owner: "stock",
	operations: new Map([
		[QUOTE, { inputSchemaRef: INPUT_SCHEMA, effect: "read" as const }],
	]),
	queries: new Set<string>(),
	inputAdapters: new Map(),
	projections: new Set<string>(),
	availability: "availability:stock@1",
	instant: true,
});

class FetchFailure extends Error {}

/**
 * One document of a service: no redirect is followed, the wait and the size are bounded, and anything but
 * a plain 200 is a failure of the service, not of the caller. The chart service refuses a request that has
 * no user agent.
 */
async function load(
	fetcher: typeof fetch,
	url: string,
	options: { timeoutMs: number; limit: number; signal?: AbortSignal },
) {
	const signal = AbortSignal.any([
		AbortSignal.timeout(options.timeoutMs),
		...(options.signal ? [options.signal] : []),
	]);
	try {
		const response = await fetcher(url, {
			redirect: "manual",
			signal,
			headers: { "user-agent": "Mozilla/5.0 (compatible; eumenes-stock)" },
		});
		if (response.status !== 200) {
			await response.body?.cancel().catch(() => {});
			throw new FetchFailure("stock_http_status");
		}
		return await readBounded(response.body, {
			limit: options.limit,
			tooLarge: "stock_too_large",
			missing: "stock_empty",
			signal,
		});
	} catch (error) {
		// The caller's own abort (a cancelled run) is not a failure of the service.
		if (options.signal?.aborted) throw options.signal.reason;
		if (error instanceof FetchFailure) throw error;
		if (
			error instanceof Error &&
			(error.message === "stock_too_large" || error.message === "stock_empty")
		)
			throw new FetchFailure(error.message);
		throw new FetchFailure(
			signal.aborted ? "stock_timeout" : "stock_unreachable",
		);
	}
}

function json(bytes: Uint8Array, code: string): unknown {
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		throw new FetchFailure(code);
	}
}

const safeCode = (error: unknown, otherwise: string) =>
	error instanceof Error && /^[a-z_]+$/.test(error.message)
		? error.message
		: otherwise;

/**
 * The stock toolchain's adapter (spec stock-instant-toolchain-design 2026-10-18). It keeps the EDINET list
 * of listed companies in memory, finds the one company a name or ticker means (that list and the search
 * service, asked together), and answers one call with the fixed sentence made from the chart service's
 * quote. A name the list does not know can still be found by the search service, so it is available
 * whether or not the list has been read.
 */
export function createStockAdapter(
	options: { fetch?: typeof fetch; now?: () => number } = {},
): DomainAdapter & { maintain(): Promise<void> } {
	const fetcher = options.fetch ?? fetch;
	const now = options.now ?? Date.now;
	let companies: ListedCompany[] = [];
	let loadedAt = Number.NEGATIVE_INFINITY;
	let triedAt = Number.NEGATIVE_INFINITY;
	let loading: Promise<void> | undefined;

	function refresh() {
		loading ??= (async () => {
			triedAt = now();
			try {
				const zip = await load(fetcher, CODE_LIST_URL, {
					timeoutMs: CODE_LIST_TIMEOUT_MS,
					limit: CODE_LIST_LIMIT_BYTES,
				});
				companies = parseCompanies(unzipCsv(zip));
				loadedAt = now();
				log.info("stock.codelist_loaded", { count: companies.length });
			} catch (error) {
				// The earlier list, if any, keeps standing.
				log.warn(
					"stock.codelist_failed",
					{ reason: safeCode(error, "stock_codelist_failed") },
					error,
				);
			} finally {
				loading = undefined;
			}
		})();
		return loading;
	}
	/** Read the list when it is missing or a day old (a failed read waits a minute before the next). */
	async function maintain() {
		const at = now();
		if (
			!loading &&
			at - loadedAt >= CODE_LIST_TTL_MS &&
			at - triedAt >= CODE_LIST_RETRY_MS
		)
			await refresh();
	}

	async function search(
		query: string,
		signal: AbortSignal,
	): Promise<SearchHit[]> {
		const url = `${SEARCH_URL}?${new URLSearchParams({ q: query, quotesCount: "10", newsCount: "0" })}`;
		const bytes = await load(fetcher, url, {
			timeoutMs: SEARCH_TIMEOUT_MS,
			limit: SEARCH_LIMIT_BYTES,
			signal,
		});
		return parseSearch(json(bytes, "stock_search_invalid"));
	}

	/** The company a query means, or undefined. A failed search leaves the listed companies to decide. */
	async function resolve(query: string, signal: AbortSignal) {
		if (directCode(query)) return resolveStock(query, companies, []);
		let hits: SearchHit[] = [];
		let failure: unknown;
		if (searchable(query))
			try {
				hits = await search(query, signal);
			} catch (error) {
				signal.throwIfAborted();
				failure = error;
			}
		const found = resolveStock(query, companies, hits);
		if (!found && failure) throw failure;
		return found;
	}

	async function quote(resolved: Resolved, signal: AbortSignal) {
		if (!validSymbol(resolved.symbol))
			throw new FetchFailure("stock_symbol_invalid");
		const bytes = await load(
			fetcher,
			`${CHART_URL}/${encodeURIComponent(resolved.symbol)}?range=1d&interval=1d`,
			{ timeoutMs: CHART_TIMEOUT_MS, limit: CHART_LIMIT_BYTES, signal },
		);
		const parsed = parseChart(json(bytes, "stock_chart_invalid"));
		const name = resolved.name ?? parsed.name;
		if (!name) throw new FetchFailure("stock_chart_invalid");
		return quoteSentence(parsed, { name, code: resolved.code });
	}

	const unsupported = () => {
		throw new Error("unsupported_operation");
	};
	return {
		ref: STOCK_ADAPTER_REF,
		describe: describeStockAdapter,
		maintain,
		availableInTransaction: () => true,
		snapshotInTransaction: () => ({}),
		invokeInTransaction: unsupported,
		readInTransaction: () => null,
		sourceInTransaction: () => null,
		targetInput: () => ({}),
		instant: {
			// No argument is filled from a list: the query is the user's own words.
			async run(operationName, input, signal): Promise<InstantResult> {
				if (operationName !== QUOTE)
					return { ok: false, code: "unsupported_operation" };
				const parsed = stockQuote.safeParse(input);
				if (!parsed.success) return { ok: false, code: "invalid_input" };
				const started = now();
				try {
					const resolved = await resolve(parsed.data.query, signal);
					if (!resolved) throw new FetchFailure("stock_not_found");
					return { ok: true, answer: await quote(resolved, signal) };
				} catch (error) {
					signal.throwIfAborted();
					const code = safeCode(error, "stock_failed");
					log.warn("stock.quote_failed", {
						reason: code,
						durationMs: now() - started,
					});
					return { ok: false, code };
				}
			},
		},
	};
}
