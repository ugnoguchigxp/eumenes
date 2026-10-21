/**
 * Tools for writing a capability bundle (docs/toolchain-extension.md §1–§4). Both commands work
 * on an isolated temporary DB seeded with every builtin and bundle, as this host would register
 * them; the product DB and settings are never opened.
 *
 *   bun scripts/toolchain-bundle.ts pins <revisionId>...   digests for the bundle's `pins`
 *   bun scripts/toolchain-bundle.ts check <file.bundle.json> [--json]
 *                                                          dry-run: every issue, nothing saved
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { migrations } from "../api/application/migrations";
import { offlineBundleHost } from "../api/application/toolchain/toolchain-adapters";
import { createCapabilities } from "../api/domains/capabilities";
import { openStore } from "../api/infrastructure/sqlite";

const BACKENDS = [
	"task-execution",
	"web",
	"history",
	"timer",
	"music",
	"dots",
	"image",
	"ui-compositions",
	"excalidraw",
	"object-recognition",
	"ocr",
	"model3d",
	"compute",
	"browser",
	"claude-code",
	"kanban",
	"codex-tasks",
	"steward",
	"world-query",
	"weather",
	"stock",
];
const USAGE =
	"使い方: bun scripts/toolchain-bundle.ts pins <revisionId>... | check <file.bundle.json> [--json]";

async function withSeeded<T>(
	work: (
		store: ReturnType<typeof openStore>,
		capabilities: ReturnType<typeof createCapabilities>,
	) => T,
): Promise<Awaited<T>> {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-bundle-"));
	try {
		const store = openStore(join(dir, "db"), migrations);
		const capabilities = createCapabilities(store, new Set(BACKENDS), {
			bundleHost: offlineBundleHost,
		});
		await capabilities.seed();
		const result = await work(store, capabilities);
		await store.close();
		return result;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

async function pins(revisionIds: string[]) {
	const rows = await withSeeded((store) =>
		store.read((db) =>
			revisionIds.map((revisionId) => {
				const row = db
					.query("SELECT definition_hash FROM capability_revisions WHERE id=?")
					.get(revisionId) as { definition_hash: string } | null;
				return { revisionId, digest: row?.definition_hash ?? null };
			}),
		),
	);
	console.log(JSON.stringify(rows, null, "\t"));
	return rows.every((r) => r.digest) ? 0 : 1;
}

async function check(file: string, json: boolean) {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(resolve(file), "utf8"));
	} catch {
		console.error("bundle_unreadable");
		return 2;
	}
	// The dry run registers inside a savepoint and rolls it back, so it needs the writer.
	const result = await withSeeded((store, capabilities) =>
		store.write((db) =>
			capabilities.importBundleInTransaction(db, raw, offlineBundleHost(), {
				dryRun: true,
			}),
		),
	);
	if (json) console.log(JSON.stringify(result, null, "\t"));
	else if (!result.issues.length)
		console.log(
			result.registered.length
				? `登録可能: ${result.registered.join(", ")}`
				: "登録可能（同じ内容が登録済み。新しいrevisionはありません）",
		);
	else
		for (const issue of result.issues)
			console.log(
				`${issue.code}  ${issue.path}${issue.ref ? `  (${issue.ref})` : ""}`,
			);
	return result.issues.length ? 1 : 0;
}

const [command, ...rest] = process.argv.slice(2);
const code =
	command === "pins" && rest.length
		? await pins(rest)
		: command === "check" && rest[0]
			? await check(rest[0], rest.includes("--json"))
			: (console.error(USAGE), 2);
process.exit(code);
