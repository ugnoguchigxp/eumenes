// Runs with the TypeScript compiler pinned to this Works release.
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

export async function buildInWorker(requestFile) {
	const input = JSON.parse(readFileSync(requestFile, "utf8"));
	const ts = require(
		join(import.meta.dir, "node_modules/typescript/lib/typescript.js"),
	);
	const inside = (path) => path.startsWith(input.stage + sep);
	const relative = (name) => name.startsWith("./") || name.startsWith("../");
	const prohibited = (name) =>
		isAbsolute(name) ||
		name.includes("?") ||
		name.includes("#") ||
		(relative(name)
			? !inside(resolve(input.stage, name))
			: !Object.hasOwn(input.exported, name));
	const diagnostic = (message) => ({ diagnostics: [message] });

	async function run() {
		for (const name of input.sourcelist) {
			const path = join(input.stage, name);
			const ast = ts.createSourceFile(
				path,
				readFileSync(path, "utf8"),
				ts.ScriptTarget.Latest,
				true,
			);
			const inspect = (node) => {
				if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
					if (
						node.attributes?.elements.some(
							(field) =>
								field.name.text === "type" &&
								ts.isStringLiteral(field.value) &&
								field.value.text === "macro",
						)
					)
						return "macro_import_forbidden";
					if (
						node.moduleSpecifier &&
						ts.isStringLiteralLike(node.moduleSpecifier)
					) {
						const request = node.moduleSpecifier.text;
						if (prohibited(request) && !relative(request))
							return "prototype_import_unregistered " + request;
					}
				}
				if (
					ts.isCallExpression(node) &&
					(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
						(ts.isIdentifier(node.expression) &&
							node.expression.text === "require"))
				) {
					const argument = node.arguments[0];
					if (!argument || !ts.isStringLiteralLike(argument))
						return "prototype_import_dynamic";
					if (prohibited(argument.text) && !relative(argument.text))
						return "prototype_import_unregistered " + argument.text;
				}
				return ts.forEachChild(node, inspect);
			};
			const error = inspect(ast);
			if (error) return { built: false, ...diagnostic(name + ": " + error) };
		}
		const diagnostics = [];
		if (input.typecheck) {
			const parsed = ts.readConfigFile(input.typeConfig, ts.sys.readFile);
			if (parsed.error)
				return { built: false, ...diagnostic("prototype_type_config_invalid") };
			const config = ts.parseJsonConfigFileContent(
				parsed.config,
				ts.sys,
				input.stage,
			);
			const program = ts.createProgram(
				[
					...config.fileNames,
					...input.sourcelist.map((file) => join(input.stage, file)),
				],
				config.options,
			);
			for (const d of [
				...config.errors,
				...ts.getPreEmitDiagnostics(program),
			].slice(0, 60)) {
				const location =
					d.file && d.start !== undefined
						? d.file.getLineAndCharacterOfPosition(d.start)
						: undefined;
				const name = d.file?.fileName.replace(input.stage + sep, "");
				const prefix =
					name && location ? name + ":" + (location.line + 1) + " " : "";
				diagnostics.push(
					prefix +
						"TS" +
						d.code +
						": " +
						ts.flattenDiagnosticMessageText(d.messageText, " "),
				);
			}
		}
		if (!input.build || (input.strict && diagnostics.length))
			return { built: false, diagnostics };
		const result = await Bun.build({
			entrypoints: [join(input.stage, input.entry)],
			outdir: input.output,
			naming: { entry: "app.[ext]", asset: "bundle/[name]-[hash].[ext]" },
			target: "browser",
			env: "disable",
			minify: true,
			throw: false,
			tsconfig: join(dirname(requestFile), "build.json"),
			plugins: [
				{
					name: "works-shared-resolution",
					setup(builder) {
						builder.onResolve({ filter: /.*/ }, ({ path, importer, kind }) => {
							if (!inside(importer)) return;
							if (relative(path)) {
								if (!inside(resolve(dirname(importer), path)))
									throw new Error("prototype_import_outside_snapshot");
								return;
							}
							if (
								kind === "url-token" &&
								!path.includes(":") &&
								!path.startsWith("/")
							)
								return;
							const target = input.exported[path];
							if (!target || !existsSync(target))
								throw new Error("prototype_import_unregistered " + path);
							return { path: target };
						});
					},
				},
			],
		});
		return {
			built: result.success,
			diagnostics: [
				...diagnostics,
				...result.logs
					.slice(0, 30)
					.map((log) => log.message.replaceAll(input.stage + sep, "")),
			],
		};
	}
	return run();
}

if (import.meta.main) {
	try {
		console.log(JSON.stringify(await buildInWorker(process.argv[2])));
	} catch (error) {
		console.log(JSON.stringify({ built: false, diagnostics: [String(error)] }));
	}
}
