import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import ts from "typescript";

/**
 * Cross-domain SQL check. A table is owned by the domain whose migration CREATEs it
 * (`api/application/migrations.ts`); a non-test file of another domain that names that table in
 * a SQL string (FROM / JOIN / INTO / UPDATE / DELETE FROM) is a boundary violation. Violations
 * that predate the check are listed in sql-boundaries.allow.json; only new ones fail.
 *   bun scripts/sql-boundaries.ts           check
 *   bun scripts/sql-boundaries.ts --write   record the current violations (keeps written reasons)
 */
export type Access = { domain: string; table: string };
export type Allowed = Access & { reason: string };

const root = resolve(import.meta.dir, "..");
const allowPath = join(root, "scripts/sql-boundaries.allow.json");
const domainsDir = "api/domains";
const defaultReason =
	"predates sql-boundaries check; migrate to the owner's API";

const isTest = (path: string) =>
	/\.(test|spec|fixture)\.[tj]sx?$/.test(path) ||
	path.split("/").includes("test");

function walk(path: string): string[] {
	try {
		return readdirSync(path).flatMap((name) => {
			if (name === "node_modules") return [];
			const file = join(path, name);
			return statSync(file).isDirectory() ? walk(file) : [file];
		});
	} catch {
		return [];
	}
}

/** `domain/0001-init` -> `domain`; a package's `memory-package/0001` belongs to `memory`. */
export function migrationOwner(id: string): string {
	return (id.split("/")[0] ?? id).replace(/-package$/, "");
}

const createTable =
	/\bCREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?([a-z_][a-z0-9_]*)/gi;

/** table -> owner, from `CREATE TABLE` in each migration. The first creator wins. */
export function tableOwners(
	migrations: readonly { id: string; sql: string }[],
): Map<string, string> {
	const owners = new Map<string, string>();
	for (const m of migrations)
		for (const match of m.sql.matchAll(createTable)) {
			const table = (match[1] as string).toLowerCase();
			if (!owners.has(table)) owners.set(table, migrationOwner(m.id));
		}
	return owners;
}

const reference =
	/\b(?:FROM|JOIN|INTO|UPDATE|DELETE\s+FROM)\s+["`]?([a-z_][a-z0-9_]*)/g;

/** Table names a SQL string literal reads or writes (uppercase keywords only, as the repo writes SQL). */
export function referencedTables(sql: string): string[] {
	return [...sql.matchAll(reference)].map((m) =>
		(m[1] as string).toLowerCase(),
	);
}

function stringLiterals(file: string, text: string): string[] {
	const out: string[] = [];
	const visit = (node: ts.Node) => {
		if (
			ts.isStringLiteral(node) ||
			ts.isNoSubstitutionTemplateLiteral(node) ||
			ts.isTemplateHead(node) ||
			ts.isTemplateMiddle(node) ||
			ts.isTemplateTail(node)
		)
			out.push(node.text);
		ts.forEachChild(node, visit);
	};
	visit(
		ts.createSourceFile(
			file,
			text,
			ts.ScriptTarget.Latest,
			false,
			ts.ScriptKind.TS,
		),
	);
	return out;
}

/** Non-test api/domains/<domain>/** files, as `[domain, repo-relative path]`. */
export function domainFiles(): Array<[string, string]> {
	return walk(join(root, domainsDir))
		.map((file) => relative(root, file).split(sep).join("/"))
		.filter((file) => /\.tsx?$/.test(file) && !isTest(file))
		.map((file): [string, string] => [file.split("/")[2] as string, file])
		.sort();
}

/** Tables a domain creates itself in source (outside migrations) are its own unless a migration says otherwise. */
export function sourceOwners(
	owners: ReadonlyMap<string, string>,
	files: ReadonlyArray<[string, string]>,
	read: (path: string) => string = (p) => readFileSync(join(root, p), "utf8"),
): Map<string, string> {
	const merged = new Map(owners);
	for (const [domain, path] of files)
		for (const literal of stringLiterals(path, read(path)))
			for (const match of literal.matchAll(createTable)) {
				const table = (match[1] as string).toLowerCase();
				if (!merged.has(table)) merged.set(table, domain);
			}
	return merged;
}

/** Every access to a table owned by another domain, deduplicated. */
export function findViolations(
	owners: ReadonlyMap<string, string>,
	files: ReadonlyArray<[string, string]>,
	read: (path: string) => string = (p) => readFileSync(join(root, p), "utf8"),
): Access[] {
	const seen = new Map<string, Access>();
	for (const [domain, path] of files) {
		for (const literal of stringLiterals(path, read(path)))
			for (const table of referencedTables(literal)) {
				const owner = owners.get(table);
				if (owner && owner !== domain)
					seen.set(`${domain}\0${table}`, { domain, table });
			}
	}
	return [...seen.values()].sort(
		(a, b) =>
			a.domain.localeCompare(b.domain) || a.table.localeCompare(b.table),
	);
}

/** Violations not covered by the allow list, formatted for output. */
export function newViolations(
	violations: readonly Access[],
	allowed: readonly Access[],
	owners: ReadonlyMap<string, string>,
): string[] {
	const ok = new Set(allowed.map((a) => `${a.domain}\0${a.table}`));
	return violations
		.filter((v) => !ok.has(`${v.domain}\0${v.table}`))
		.map(
			(v) =>
				`sql boundary: ${v.domain} accesses table ${v.table} owned by ${owners.get(v.table)} (use the owner's API, or record it in scripts/sql-boundaries.allow.json)`,
		);
}

function readAllowed(): Allowed[] {
	try {
		return JSON.parse(readFileSync(allowPath, "utf8")) as Allowed[];
	} catch {
		return [];
	}
}

if (import.meta.main) {
	const { migrations } = await import("../api/application/migrations");
	const files = domainFiles();
	const owners = sourceOwners(tableOwners(migrations), files);
	const violations = findViolations(owners, files);
	const allowed = readAllowed();
	if (process.argv.includes("--write")) {
		const reasons = new Map(
			allowed.map((a) => [`${a.domain}\0${a.table}`, a.reason]),
		);
		const next = violations.map((v) => ({
			...v,
			reason: reasons.get(`${v.domain}\0${v.table}`) ?? defaultReason,
		}));
		writeFileSync(allowPath, `${JSON.stringify(next, null, "\t")}\n`);
		console.log(
			`[sql-boundaries] recorded ${next.length} accesses over ${owners.size} tables`,
		);
	} else {
		const errors = newViolations(violations, allowed, owners);
		const stale = allowed.length - (violations.length - errors.length);
		if (errors.length) {
			console.error(errors.join("\n"));
			process.exit(1);
		}
		console.log(
			`[sql-boundaries] ok: ${owners.size} tables, ${violations.length} allowed cross-domain accesses${stale > 0 ? `, ${stale} stale allow entries` : ""}`,
		);
	}
}
