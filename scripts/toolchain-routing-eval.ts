/**
 * Retrieval evaluation of toolchains: each registered example request must place its own
 * toolchain among the top k candidates (recall@k). FTS-only and hybrid (with the saved LARM
 * embedding provider) are reported separately. Uses an isolated temporary DB; the product DB
 * and settings are only read for the saved LARM connection.
 *
 *   bun scripts/toolchain-routing-eval.ts --run [--k 4] [--fts-only]
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../api/infrastructure/sqlite";
import { migrations } from "../api/application/migrations";
import { createCapabilities } from "../api/domains/capabilities";
import { offlineBundleHost } from "../api/application/toolchain/toolchain-adapters";
import { createLarmPlayground } from "../api/domains/larm";
import { resolveLarmToken } from "../api/infrastructure/auth-config";
import { liveLarmSettings } from "./live-larm";

const args = process.argv.slice(2);
if (!args.includes("--run"))
	throw new Error("use --run to evaluate with an isolated temporary DB");
const k = Number(args[args.indexOf("--k") + 1] ?? 4) || 4;
const ftsOnly = args.includes("--fts-only");
const dir = mkdtempSync(join(tmpdir(), "eumenes-routing-eval-"));
try {
	const store = openStore(join(dir, "db"), migrations);
	const capabilities = createCapabilities(
		store,
		new Set(["web", "history", "timer", "music", "dots"]),
		{
			// Bundled toolchains (the timer) are evaluated as this host would register them.
			bundleHost: offlineBundleHost,
		},
	);
	await capabilities.seed();
	const embed = ftsOnly
		? undefined
		: (() => {
				const saved = liveLarmSettings();
				const client = createLarmPlayground({
					...saved,
					baseUrl: saved.baseUrl ?? undefined,
					token: resolveLarmToken(process.env),
				});
				return client.embed;
			})();
	let space:
		| Parameters<typeof capabilities.saveToolchainVectorsInTransaction>[1]
		| undefined;
	if (embed) {
		const probe = await embed(
			["toolchain"],
			"passage",
			AbortSignal.timeout(30000),
		);
		space = probe.space;
		const pending = store.read((db) =>
			capabilities.pendingToolchainVectorsInTransaction(db, probe.space),
		);
		for (let i = 0; i < pending.length; i += 32) {
			const batch = pending.slice(i, i + 32);
			const r = await embed(
				batch.map((p) => p.text),
				"passage",
				AbortSignal.timeout(30000),
			);
			await store.write((db) =>
				capabilities.saveToolchainVectorsInTransaction(
					db,
					r.space,
					batch.map((p, j) => ({ ...p, vector: r.vectors[j]! })),
				),
			);
		}
	}
	const cases = store.read((db) =>
		capabilities.toolchainExamplesInTransaction(db),
	);
	const rows: Array<{ id: string; example: string; rank: number | null }> = [];
	for (const c of cases)
		for (const example of c.examples) {
			// The example is itself an indexed passage (see the note in the output).
			const query = embed
				? (await embed([example], "query", AbortSignal.timeout(10000)))
						.vectors[0]
				: undefined;
			const cards = store.read((db) =>
				capabilities.toolchainCandidatesInTransaction(db, {
					text: example,
					vector: query && space ? { space, values: query } : undefined,
					available: () => true,
					limit: k,
				}),
			);
			const at = cards.findIndex((card) => card.id === c.id);
			rows.push({ id: c.id, example, rank: at >= 0 ? at + 1 : null });
		}
	const hit = rows.filter((r) => r.rank !== null && r.rank <= k).length;
	console.log(
		JSON.stringify(
			{
				mode: embed ? "hybrid" : "fts",
				k,
				recall: rows.length ? hit / rows.length : null,
				cases: rows.length,
				misses: rows.filter((r) => r.rank === null || r.rank > k),
				note: "Examples are also indexed passages; this measures registration consistency, not generalisation. Add held-out utterances for the latter.",
			},
			null,
			2,
		),
	);
	await store.close();
} finally {
	rmSync(dir, { recursive: true, force: true });
}
