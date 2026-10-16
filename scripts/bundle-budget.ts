import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

/**
 * Ratchet for the browser's initial JavaScript, measured on the built dist-web:
 * the entry chunk (the module script in index.html) and every script the page
 * loads at startup (entry plus its modulepreload chunks), as gzip bytes.
 *   bun scripts/bundle-budget.ts            check against bundle-budget.json
 *   bun scripts/bundle-budget.ts --write    record the current values
 * Run `bun run build:web` first. A value may grow by at most TOLERANCE; a build
 * that shrinks beyond RATCHET_NOTICE asks for --write so the gain is kept.
 */
export const TOLERANCE = 0.02;
export const RATCHET_NOTICE = 0.05;
export type Budget = { entryGzip: number; initialGzip: number };
export type Measure = Budget & { files: Record<string, number> };

const root = resolve(import.meta.dir, "..");
const dist = join(root, "dist-web");
const budgetPath = join(root, "scripts/bundle-budget.json");

/** Scripts index.html loads before any user action, as dist-relative paths. */
export function initialScripts(html: string): {
	entry: string;
	preloaded: string[];
} {
	const attr = (tag: string, name: string) =>
		new RegExp(`${name}="([^"]+)"`).exec(tag)?.[1]?.replace(/^\//, "");
	const entries = [...html.matchAll(/<script\b[^>]*>/g)]
		.filter((m) => /type="module"/.test(m[0]))
		.map((m) => attr(m[0], "src"))
		.filter((src): src is string => !!src);
	const preloaded = [...html.matchAll(/<link\b[^>]*>/g)]
		.filter((m) => /rel="modulepreload"/.test(m[0]))
		.map((m) => attr(m[0], "href"))
		.filter((href): href is string => !!href);
	const entry = entries[0];
	if (!entry || entries.length !== 1)
		throw new Error("index.html must load exactly one module entry script");
	return { entry, preloaded };
}

export function measure(distDir = dist): Measure {
	const indexPath = join(distDir, "index.html");
	if (!existsSync(indexPath))
		throw new Error("dist-web/index.html is missing: run `bun run build:web`");
	const { entry, preloaded } = initialScripts(readFileSync(indexPath, "utf8"));
	const files: Record<string, number> = {};
	for (const file of new Set([entry, ...preloaded]))
		files[file] = gzipSync(readFileSync(join(distDir, file)), {
			level: 9,
		}).length;
	return {
		entryGzip: files[entry]!,
		initialGzip: Object.values(files).reduce((a, b) => a + b, 0),
		files,
	};
}

export type Verdict = { failures: string[]; notices: string[] };
export function compare(current: Budget, baseline: Budget): Verdict {
	const failures: string[] = [];
	const notices: string[] = [];
	for (const key of ["entryGzip", "initialGzip"] as const) {
		const limit = Math.floor(baseline[key] * (1 + TOLERANCE));
		if (current[key] > limit)
			failures.push(
				`${key}: ${current[key]} B exceeds the recorded ${baseline[key]} B (limit ${limit} B)`,
			);
		else if (current[key] < baseline[key] * (1 - RATCHET_NOTICE))
			notices.push(
				`${key}: ${current[key]} B is well below the recorded ${baseline[key]} B; run \`bun scripts/bundle-budget.ts --write\` to ratchet`,
			);
	}
	return { failures, notices };
}

if (import.meta.main) {
	const current = measure();
	const { files: _files, ...values } = current;
	if (process.argv.includes("--write")) {
		writeFileSync(budgetPath, JSON.stringify(values, null, "\t") + "\n");
		console.log(
			`bundle-budget: recorded entry ${values.entryGzip} B, initial ${values.initialGzip} B (gzip)`,
		);
	} else {
		if (!existsSync(budgetPath)) {
			console.error("bundle-budget: no baseline; run with --write");
			process.exit(1);
		}
		const baseline = JSON.parse(readFileSync(budgetPath, "utf8")) as Budget;
		const { failures, notices } = compare(values, baseline);
		for (const note of notices) console.log(`bundle-budget: ${note}`);
		if (failures.length) {
			for (const failure of failures)
				console.error(`bundle-budget: ${failure}`);
			process.exit(1);
		}
		console.log(
			`bundle-budget: ok, entry ${values.entryGzip} B, initial ${values.initialGzip} B (gzip)`,
		);
	}
}
