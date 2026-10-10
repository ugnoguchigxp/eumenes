import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import ts from "typescript";

/**
 * Ratchet for file and function size. Entries over the threshold are recorded
 * in size-budget.json; the check fails only when one grows or a new one appears.
 *   bun scripts/size-budget.ts [paths...]   check (optionally limited to paths)
 *   bun scripts/size-budget.ts --write      record the current values
 */
export const FILE_LIMIT = 800;
export const FUNCTION_LIMIT = 300;
export type Budget = {
	files: Record<string, number>;
	functions: Record<string, number>;
};

const root = resolve(import.meta.dir, "..");
const budgetPath = join(root, "scripts/size-budget.json");
const skipped = new Set(["node_modules", "dist-web", ".git"]);
const isTest = (path: string) =>
	/\.(test|spec|fixture)\.[tj]sx?$/.test(path) ||
	path.split("/").includes("test");

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
/** Non-test .ts/.tsx under api, web/src, client, cli and packages/*\/src. */
export function sourceFiles(): string[] {
	const dirs = ["api", "web/src", "client", "cli"];
	for (const name of readdirSync(join(root, "packages")))
		dirs.push(`packages/${name}/src`);
	return dirs
		.flatMap((dir) => walk(join(root, dir)))
		.map((file) => relative(root, file).split(sep).join("/"))
		.filter((file) => /\.tsx?$/.test(file) && !isTest(file))
		.sort();
}

function propertyName(name: ts.Node | undefined): string | null {
	if (!name) return null;
	return ts.isIdentifier(name) ||
		ts.isStringLiteral(name) ||
		ts.isPrivateIdentifier(name)
		? name.text
		: null;
}
/** A function's own name, else the variable/property that holds it. */
function ownName(node: ts.Node): string | null {
	if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) {
		const own = propertyName(node.name);
		if (own) return own;
	}
	let parent = node.parent;
	while (
		parent &&
		(ts.isParenthesizedExpression(parent) ||
			ts.isAsExpression(parent) ||
			ts.isSatisfiesExpression(parent) ||
			ts.isNonNullExpression(parent))
	)
		parent = parent.parent;
	if (!parent) return null;
	if (ts.isVariableDeclaration(parent)) return propertyName(parent.name);
	if (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent))
		return propertyName(parent.name);
	if (
		ts.isBinaryExpression(parent) &&
		ts.isPropertyAccessExpression(parent.left)
	)
		return parent.left.name.text;
	return null;
}
const isFunction = (node: ts.Node): node is ts.FunctionLikeDeclaration =>
	ts.isFunctionDeclaration(node) ||
	ts.isFunctionExpression(node) ||
	ts.isArrowFunction(node);

/** Measures one file; function ids are `<outer>.<inner>` chains, not line numbers. */
export function measure(
	path: string,
	text: string,
): { lines: number; functions: Record<string, number> } {
	const tree = ts.createSourceFile(
		path,
		text,
		ts.ScriptTarget.Latest,
		true,
		path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
	);
	const functions: Record<string, number> = {};
	const visit = (node: ts.Node, chain: string[]) => {
		let next = chain;
		if (isFunction(node)) {
			const name = ownName(node) ?? "<anonymous>";
			next = [...chain, name];
			const start = tree.getLineAndCharacterOfPosition(
				node.getStart(tree),
			).line;
			const end = tree.getLineAndCharacterOfPosition(node.getEnd()).line;
			let key = next.join(".");
			for (let n = 2; key in functions; n++) key = `${next.join(".")}~${n}`;
			functions[key] = end - start + 1;
		}
		ts.forEachChild(node, (child) => visit(child, next));
	};
	visit(tree, []);
	const lines = text.endsWith("\n")
		? text.split("\n").length - 1
		: text.split("\n").length;
	return { lines, functions };
}

/** Everything currently over its threshold. */
export function measureAll(paths: string[] = sourceFiles()): Budget {
	const budget: Budget = { files: {}, functions: {} };
	for (const path of paths) {
		const { lines, functions } = measure(
			path,
			readFileSync(join(root, path), "utf8"),
		);
		if (lines > FILE_LIMIT) budget.files[path] = lines;
		for (const [name, size] of Object.entries(functions))
			if (size > FUNCTION_LIMIT) budget.functions[`${path}#${name}`] = size;
	}
	return budget;
}

/** Violations: over-threshold entries that are new or larger than recorded. */
export function compare(current: Budget, recorded: Budget): string[] {
	const errors: string[] = [];
	for (const kind of ["files", "functions"] as const) {
		const limit = kind === "files" ? FILE_LIMIT : FUNCTION_LIMIT;
		for (const [name, size] of Object.entries(current[kind])) {
			const before = recorded[kind][name];
			if (before === undefined)
				errors.push(
					`size-budget: new ${kind === "files" ? "file" : "function"} over ${limit} lines: ${name} (${size})`,
				);
			else if (size > before)
				errors.push(
					`size-budget: ${name} grew ${before} -> ${size} (limit ${limit})`,
				);
		}
	}
	return errors;
}

function readBudget(): Budget {
	try {
		const parsed = JSON.parse(
			readFileSync(budgetPath, "utf8"),
		) as Partial<Budget>;
		return { files: parsed.files ?? {}, functions: parsed.functions ?? {} };
	} catch {
		return { files: {}, functions: {} };
	}
}
const sorted = (record: Record<string, number>) =>
	Object.fromEntries(
		Object.entries(record).sort(([a], [b]) => a.localeCompare(b)),
	);

if (import.meta.main) {
	const args = process.argv.slice(2).filter((arg) => arg !== "--");
	if (args.includes("--write")) {
		const budget = measureAll();
		writeFileSync(
			budgetPath,
			`${JSON.stringify(
				{ files: sorted(budget.files), functions: sorted(budget.functions) },
				null,
				"\t",
			)}\n`,
		);
		console.log(
			`size-budget: wrote ${Object.keys(budget.files).length} files, ${Object.keys(budget.functions).length} functions`,
		);
	} else {
		const scope = args.map((arg) => arg.replace(/\/+$/, ""));
		const paths = sourceFiles().filter(
			(file) =>
				scope.length === 0 ||
				scope.some((dir) => file === dir || file.startsWith(`${dir}/`)),
		);
		const errors = compare(measureAll(paths), readBudget());
		if (errors.length) {
			console.error(errors.join("\n"));
			process.exit(1);
		}
		console.log(`size-budget ok (${paths.length} files)`);
	}
}
