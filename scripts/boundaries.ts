import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import {
	closure,
	type Domain,
	dependsOf,
	domains,
	type Layer,
	ownedPaths,
} from "./domains";

const root = resolve(import.meta.dir, "..");
function owner(path: string): { domain: Domain; root: string } | null {
	for (const domain of Object.keys(domains) as Domain[])
		for (const location of ownedPaths(domain)) {
			if (!location) continue;
			const base = resolve(root, location);
			if (path === base || path.startsWith(`${base}${sep}`))
				return { domain: domain as Domain, root: base };
		}
	return null;
}

type Reference = { spec: string | null };
/** Every module reference: import/export-from, dynamic import() and import("…") types. */
function references(tree: ts.SourceFile): Reference[] {
	const found: Reference[] = [];
	const visit = (node: ts.Node) => {
		if (
			(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
			node.moduleSpecifier
		) {
			if (ts.isStringLiteral(node.moduleSpecifier))
				found.push({ spec: node.moduleSpecifier.text });
		} else if (
			ts.isCallExpression(node) &&
			node.expression.kind === ts.SyntaxKind.ImportKeyword
		) {
			const arg = node.arguments[0];
			found.push({
				spec:
					arg &&
					(ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))
						? arg.text
						: null,
			});
		} else if (ts.isImportTypeNode(node)) {
			if (
				ts.isLiteralTypeNode(node.argument) &&
				ts.isStringLiteral(node.argument.literal)
			)
				found.push({ spec: node.argument.literal.text });
		}
		ts.forEachChild(node, visit);
	};
	visit(tree);
	return found;
}

const isTestFile = (path: string) =>
	path.includes(`${sep}test${sep}`) || /\.test\.[tj]sx?$/.test(path);
const isFixtureFile = (path: string) => /\.fixture\.[tj]sx?$/.test(path);
const inside = (path: string, dir: string) =>
	path === resolve(root, dir) || path.startsWith(`${resolve(root, dir)}${sep}`);
/** Which dependency list governs this file: tests see everything, web code only `web`. */
const fileLayer = (path: string): Layer =>
	isTestFile(path)
		? "test"
		: inside(path, "web/src") || inside(path, "packages/artifact-ui")
			? "web"
			: "api";
const apiContracts = /^api\/domains\/[a-z-]+\/contracts$/;
/** World's host contracts import vendor types; web/client may only use its view contract. */
const worldViewContract = "api/domains/world/contracts/view";
const worldContracts = "api/domains/world/contracts";
const layerOf = (path: string) =>
	inside(path, "web/src")
		? "web"
		: inside(path, "client")
			? "client"
			: inside(path, "cli")
				? "cli"
				: null;
/** Layer rules for code outside a backend domain (tests are exempt: they wire everything). */
function checkLayer(
	name: string,
	path: string,
	spec: string,
	target: string,
): string[] {
	const layer = layerOf(path);
	if (!layer || isTestFile(path)) return [];
	const rel = relative(root, target).split(sep).join("/");
	if (rel.startsWith("..")) return [];
	if (layer === "web" || layer === "client") {
		if (rel === worldContracts || rel === `${worldContracts}/index`)
			return [
				`${name}: ${layer} import ${spec} must use ${worldViewContract}, not the world host contracts`,
			];
		if (rel === worldViewContract) return [];
		if (inside(target, "api") && !apiContracts.test(rel))
			return [
				`${name}: ${layer} import ${spec} must use api/domains/<domain>/contracts`,
			];
		return [];
	}
	if (
		inside(target, "api") &&
		!apiContracts.test(rel) &&
		rel !== "api/infrastructure/auth-config"
	)
		return [
			`${name}: cli import ${spec} may only use client/**, api/domains/<domain>/contracts or api/infrastructure/auth-config`,
		];
	if (inside(target, "web"))
		return [`${name}: cli import ${spec} must not reach web/**`];
	return [];
}

const posix = (path: string) => path.split(sep).join("/");
const aliasPrefixes = ["@/", "~/", "api/", "web/"];
/** `api/application/**` may reach a domain only through its public entry or contracts. */
function checkApplication(
	name: string,
	path: string,
	spec: string,
	target: string,
): string[] {
	if (!inside(path, "api/application")) return [];
	const match = /^api\/domains\/([a-z-]+)(?:\/(.*))?$/.exec(
		posix(relative(root, target)),
	);
	if (!match) return [];
	const [, domain, rest = ""] = match;
	const tests = isTestFile(path) || isFixtureFile(path);
	const allowed =
		rest === "" ||
		rest === "index" ||
		rest === "contracts" ||
		rest.startsWith("contracts/") ||
		(tests && (rest === "test" || rest.startsWith("test/")));
	return allowed
		? []
		: [`${name}: application must use ${domain} public entry (${spec})`];
}
/** `api/infrastructure/**` is the lowest layer: no domains, no application. */
function checkInfrastructure(
	name: string,
	path: string,
	spec: string,
	target: string,
): string[] {
	if (!inside(path, "api/infrastructure") || isTestFile(path)) return [];
	return inside(target, "api/domains") || inside(target, "api/application")
		? [`${name}: infrastructure must not import domains/application (${spec})`]
		: [];
}

/** Checks one file's source text; `name` is only used in messages. */
export function checkSource(name: string, text: string): string[] {
	const errors: string[] = [];
	const path = resolve(root, name);
	const source = owner(path);
	const tree = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
	for (const { spec } of references(tree)) {
		if (spec === null) {
			errors.push(`${name}: boundary_dynamic_specifier`);
			continue;
		}
		if (!spec.startsWith(".")) {
			if (aliasPrefixes.some((prefix) => spec.startsWith(prefix)))
				errors.push(`${name}: boundary_alias_forbidden (${spec})`);
			continue;
		}
		const targetPath = resolve(dirname(path), spec);
		if (
			inside(path, "packages/coding-runner") &&
			["api", "web", "client", "cli"].some((dir) => inside(targetPath, dir))
		)
			errors.push(`${name}: coding-runner must not import product layers`);
		if (
			inside(path, "api/domains/coding") &&
			!isTestFile(path) &&
			inside(targetPath, "packages/coding-runner") &&
			!["contracts", "client"].some(
				(entry) =>
					targetPath === resolve(root, `packages/coding-runner/src/${entry}`),
			)
		)
			errors.push(`${name}: coding must use runner contracts/client entry`);
		errors.push(...checkLayer(name, path, spec, targetPath));
		errors.push(...checkApplication(name, path, spec, targetPath));
		errors.push(...checkInfrastructure(name, path, spec, targetPath));
		if (!source) continue;
		const target = owner(targetPath);
		if (!target || target.domain === source.domain) continue;
		const layer = fileLayer(path);
		const allowed = (
			layer === "test"
				? closure(source.domain, "test")
				: dependsOf(source.domain, layer)
		).includes(target.domain);
		if (!allowed)
			errors.push(
				`${name}: forbidden dependency ${source.domain} -> ${target.domain}`,
			);
		const suffix = relative(target.root, targetPath);
		if (suffix !== "" && suffix !== "contracts")
			errors.push(
				`${name}: import ${spec} bypasses ${target.domain} public entry`,
			);
	}
	return errors;
}

const checked = (path: string) =>
	owner(path) ||
	layerOf(path) ||
	inside(path, "api/application") ||
	inside(path, "api/infrastructure");

/** Actual domain -> domain edges (`a -> b`) per file layer. */
export function actualEdges(files: string[]): Record<Layer, Set<string>> {
	const edges: Record<Layer, Set<string>> = {
		api: new Set(),
		web: new Set(),
		test: new Set(),
	};
	for (const name of files) {
		const path = resolve(root, name);
		const source = owner(path);
		if (!source || !existsSync(path) || !/\.[cm]?[tj]sx?$/.test(path)) continue;
		const tree = ts.createSourceFile(
			path,
			readFileSync(path, "utf8"),
			ts.ScriptTarget.Latest,
			true,
		);
		for (const { spec } of references(tree)) {
			if (!spec?.startsWith(".")) continue;
			const target = owner(resolve(dirname(path), spec));
			if (target && target.domain !== source.domain)
				edges[fileLayer(path)].add(`${source.domain} -> ${target.domain}`);
		}
	}
	return edges;
}

/** Declared dependencies no file uses. Needs the whole tree, so `--all` only. */
export function unusedDependencies(files: string[]): string[] {
	const edges = actualEdges(files);
	const errors: string[] = [];
	for (const domain of Object.keys(domains) as Domain[])
		for (const layer of ["api", "web", "test"] as const)
			for (const dep of domains[domain].depends[layer])
				if (!edges[layer].has(`${domain} -> ${dep}`))
					errors.push(`unused dependency ${domain} -> ${dep} (${layer})`);
	return errors;
}

export function checkBoundaries(files: string[]): string[] {
	const errors: string[] = [];
	for (const name of files) {
		const path = resolve(root, name);
		if (!checked(path) || !existsSync(path)) continue;
		if (!/\.[cm]?[tj]sx?$/.test(path)) continue;
		errors.push(...checkSource(name, readFileSync(path, "utf8")));
	}
	for (const domain of Object.keys(domains) as Domain[]) {
		for (const layer of ["api", "web", "test"] as const)
			if (closure(domain, layer).length > Object.keys(domains).length)
				errors.push(`cycle from ${domain} (${layer})`);
	}
	return errors;
}

const skipped = new Set([
	"node_modules",
	"dist-web",
	"verification-reports",
	".git",
	"test-results",
	"playwright-report",
]);
function walk(path: string): string[] {
	try {
		return readdirSync(path).flatMap((name) => {
			if (skipped.has(name)) return [];
			const file = join(path, name);
			return statSync(file).isDirectory() ? walk(file) : [file];
		});
	} catch {
		return [];
	}
}
/** Every checked source file of the product, relative to the repository root. */
export function allSourceFiles(): string[] {
	return [
		"api",
		"web/src",
		"client",
		"cli",
		"packages/artifact-ui/src",
		"packages/coding-runner/src",
		"packages/coding-runner/test",
	]
		.flatMap((dir) => walk(join(root, dir)))
		.filter((file) => /\.tsx?$/.test(file))
		.map((file) => relative(root, file));
}

if (import.meta.main) {
	const files = allSourceFiles();
	if (process.argv.includes("--report")) {
		const edges = actualEdges(files);
		for (const layer of ["api", "web", "test"] as const)
			console.log(
				`${layer}:\n${[...edges[layer]]
					.sort()
					.map((edge) => `  ${edge}`)
					.join("\n")}`,
			);
	} else {
		const errors = [...checkBoundaries(files), ...unusedDependencies(files)];
		if (errors.length) {
			console.error(errors.join("\n"));
			process.exit(1);
		}
		console.log(`boundaries ok (${files.length} files)`);
	}
}
