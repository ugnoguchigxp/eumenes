/**
 * The search check (the toolchain search and choice design, section 6): asks the running backend where the
 * toolchains chosen for past requests stand in the search now, and whether its slots offer them. Prints counts and
 * the toolchain ids and ranks of the requests it would not offer, never the requests' words. No LARM call is made.
 *
 *   bun scripts/toolchain-search-check.ts [--api=http://127.0.0.1:8787] [--db=./data/eumenes.sqlite3]
 */
import { readApiToken } from "../api/infrastructure/auth-config";

type Result = {
	checked: number;
	offered: number;
	ranks: Record<string, number>;
	unavailable: number;
	unindexed: number;
	missed: Array<{
		selectionId: string;
		toolchainId: string;
		rank: number | null;
		createdAt: number;
	}>;
};

const args = process.argv.slice(2);
const value = (name: string, fallback: string) =>
	args.find((v) => v.startsWith(`${name}=`))?.slice(name.length + 1) ??
	fallback;
const api = new URL(value("--api", "http://127.0.0.1:8787"));
if (
	api.protocol !== "http:" ||
	!["127.0.0.1", "localhost"].includes(api.hostname)
)
	throw new Error("search_check_api_invalid");
const dbPath = value(
	"--db",
	process.env.EUMENES_DB || "./data/eumenes.sqlite3",
);
const response = await fetch(new URL("/api/toolchains/search-check", api), {
	headers: {
		Authorization: `Bearer ${readApiToken({ ...process.env, EUMENES_DB: dbPath })}`,
	},
	signal: AbortSignal.timeout(60_000),
});
if (!response.ok) throw new Error(`search_check_http_${response.status}`);
const result = (await response.json()) as Result;
const percent = (n: number) =>
	result.checked ? `${Math.round((n / result.checked) * 100)}%` : "-";
console.log(
	`checked ${result.checked}, offered ${result.offered} (${percent(result.offered)}), toolchain unavailable ${result.unavailable}, no index ${result.unindexed}`,
);
console.log("rank of the chosen toolchain by similarity:");
for (const [rank, count] of Object.entries(result.ranks).sort(
	([a], [b]) => Number.parseInt(a) - Number.parseInt(b),
))
	console.log(`  ${rank.padStart(3)}: ${count} (${percent(count)})`);
if (result.missed.length) {
	console.log("not offered by the slots:");
	for (const miss of result.missed)
		console.log(
			`  ${new Date(miss.createdAt).toISOString().slice(0, 16)} ${miss.toolchainId} rank ${miss.rank ?? "9+"}`,
		);
}
