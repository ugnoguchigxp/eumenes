import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { closure, type Domain, domains } from "./domains";

const root = resolve(import.meta.dir, "..");
function owner(path: string): { domain: Domain; root: string } | null {
	for (const [domain, info] of Object.entries(domains))
		for (const location of [info.backend, info.web, info.components]) {
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
const inside = (path: string, dir: string) =>
	path === resolve(root, dir) || path.startsWith(`${resolve(root, dir)}${sep}`);
const apiContracts = /^api\/domains\/[a-z-]+\/contracts$/;
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
		if (!spec.startsWith(".")) continue;
		const targetPath = resolve(dirname(path), spec);
		errors.push(...checkLayer(name, path, spec, targetPath));
		if (!source) continue;
		const target = owner(targetPath);
		if (!target || target.domain === source.domain) continue;
		const allowed = (
			isTestFile(path)
				? closure(source.domain)
				: (domains[source.domain].depends as readonly Domain[])
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

export function checkBoundaries(files: string[]): string[] {
	const errors: string[] = [];
	for (const name of files) {
		const path = resolve(root, name);
		if ((!owner(path) && !layerOf(path)) || !existsSync(path)) continue;
		if (!/\.[cm]?[tj]sx?$/.test(path)) continue;
		errors.push(...checkSource(name, readFileSync(path, "utf8")));
	}
	for (const domain of Object.keys(domains) as Domain[]) {
		if (closure(domain).length > Object.keys(domains).length)
			errors.push(`cycle from ${domain}`);
	}
	return errors;
}
