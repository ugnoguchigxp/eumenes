import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { closure, type Domain, domains } from "./domains";

const root = resolve(import.meta.dir, "..");
function owner(path: string): { domain: Domain; root: string } | null {
	for (const [domain, info] of Object.entries(domains))
		for (const location of [info.backend, info.web]) {
			if (!location) continue;
			const base = resolve(root, location);
			if (path === base || path.startsWith(`${base}${sep}`))
				return { domain: domain as Domain, root: base };
		}
	return null;
}
export function checkBoundaries(files: string[]): string[] {
	const errors: string[] = [];
	for (const name of files) {
		const path = resolve(root, name);
		const source = owner(path);
		if (!source || !existsSync(path)) continue;
		const tree = ts.createSourceFile(
			path,
			readFileSync(path, "utf8"),
			ts.ScriptTarget.Latest,
			true,
		);
		for (const node of tree.statements) {
			if (
				!ts.isImportDeclaration(node) ||
				!ts.isStringLiteral(node.moduleSpecifier)
			)
				continue;
			const spec = node.moduleSpecifier.text;
			if (!spec.startsWith(".")) continue;
			const targetPath = resolve(dirname(path), spec);
			const target = owner(targetPath);
			if (!target || target.domain === source.domain) continue;
			const allowed = (
				path.includes(`${sep}test${sep}`)
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
	}
	for (const domain of Object.keys(domains) as Domain[]) {
		if (closure(domain).length > Object.keys(domains).length)
			errors.push(`cycle from ${domain}`);
	}
	return errors;
}
