import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applicationPaths, type Depends, domains } from "./domains";

/**
 * Generates the domain table in docs/domains.md from scripts/domains.ts.
 *   bun scripts/domain-docs.ts          rewrite the generated block
 *   bun scripts/domain-docs.ts --check  exit 1 when the block is out of date
 */
export const START = "<!-- domains:start -->";
export const END = "<!-- domains:end -->";

type Info = {
	tier: number;
	backend: string | null;
	web: string | null;
	components: string | null;
	depends: Depends;
};
type Graph = Record<string, Info>;

const root = join(import.meta.dir, "..");

/** `<dir>/index.ts(x)` when it exists, otherwise the directory itself. */
export function entryOf(
	dir: string | null,
	exists: (path: string) => boolean = (p) => existsSync(join(root, p)),
): string {
	if (!dir) return "なし";
	for (const name of ["index.ts", "index.tsx"]) {
		if (exists(`${dir}/${name}`)) return `\`${dir}/${name}\``;
	}
	return `\`${dir}/\``;
}

function names(list: readonly string[]): string {
	return list.length ? list.map((d) => `\`${d}\``).join("、") : "なし";
}

export function renderDomainTable(
	graph: Graph = domains,
	exists?: (path: string) => boolean,
): string {
	const rows = Object.entries(graph).map(([name, info]) =>
		[
			`\`${name}\``,
			String(info.tier),
			entryOf(info.backend, exists),
			entryOf(info.web, exists),
			entryOf(info.components, exists),
			names(info.depends.api),
			names(info.depends.web),
			names(info.depends.test),
		].join(" | "),
	);
	return [
		"| Domain | Tier | Backend 入口 | Web 入口 | Components | 依存 (api) | 依存 (web) | 依存 (試験のみ) |",
		"| --- | --- | --- | --- | --- | --- | --- | --- |",
		...rows.map((row) => `| ${row} |`),
	].join("\n");
}

/** Replaces the text between the markers; throws when a marker is missing. */
export function replaceBlock(doc: string, body: string): string {
	const start = doc.indexOf(START);
	const end = doc.indexOf(END);
	if (start < 0 || end < start)
		throw new Error(`domain_docs_markers_missing:${START}..${END}`);
	return `${doc.slice(0, start + START.length)}\n${body}\n${doc.slice(end)}`;
}

export function generate(doc: string): string {
	return replaceBlock(doc, renderDomainTable());
}

function listApplicationTsFiles(
	base: string,
	rel = "api/application",
): string[] {
	const dir = join(base, rel);
	if (!existsSync(dir)) return [];
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const next = `${rel}/${entry.name}`;
		if (entry.isDirectory()) out.push(...listApplicationTsFiles(base, next));
		else if (entry.isFile() && /\.tsx?$/.test(entry.name)) out.push(next);
	}
	return out.sort();
}

/** Returns any `api/application/**` TS/TSX file not owned by any domain's `applicationPaths`. */
export function unownedApplicationFiles(
	base = root,
	ownership: Partial<Record<string, readonly string[]>> = applicationPaths,
): string[] {
	const owned = Object.values(ownership).flatMap((list) => list ?? []);
	return listApplicationTsFiles(base).filter(
		(file) =>
			!owned.some((entry) => file === entry || file.startsWith(`${entry}/`)),
	);
}

if (import.meta.main) {
	const file = join(root, "docs/domains.md");
	const current = readFileSync(file, "utf8");
	const next = generate(current);
	if (process.argv.includes("--check")) {
		const unowned = unownedApplicationFiles(root);
		let failed = false;
		if (next !== current) {
			console.error(
				"docs/domains.md の domain 表が scripts/domains.ts と一致しません。`bun scripts/domain-docs.ts` で更新してください。",
			);
			failed = true;
		}
		if (unowned.length) {
			console.error(
				`api/application に未所有のファイルがあります (scripts/domains.ts の applicationPaths に追加してください):\n${unowned.map((p) => `  ${p}`).join("\n")}`,
			);
			failed = true;
		}
		if (failed) process.exit(1);
		console.log("docs/domains.md: domain 表と application 所有は最新です");
	} else if (next !== current) {
		writeFileSync(file, next);
		console.log("docs/domains.md: domain 表を更新しました");
	} else console.log("docs/domains.md: 変更なし");
}
